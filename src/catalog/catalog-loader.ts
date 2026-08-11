import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import { z } from "zod";

import { assertCurrentRequestActive } from "../application/request-execution.js";
import {
  canonicalJson,
  createSkillRevision,
  sha256Hex,
} from "../domain/catalog/canonical-revision.js";
import {
  advisoryStatusFor,
  parseAdvisoryChain,
  verifyAdvisoryChain,
} from "../domain/catalog/advisory-chain.js";
import { assertSafeResourcePath } from "../domain/catalog/resource-path.js";
import { normalizeUtf8 } from "../domain/catalog/text-normalization.js";
import type {
  CatalogRelease,
  CatalogSkillInventoryEntry,
  CatalogSkillMetadata,
  RevisionPublicationRecord,
  SkillRevision,
  VerifiedAdvisoryChain,
} from "../domain/catalog/types.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION_PATTERN =
  /^(?!latest$|main$|master$|HEAD$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class CatalogValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

export interface CatalogReadHooks {
  readonly afterOpen?:
    ((relativePath: string, descriptor: number) => void) | undefined;
}

interface OpenedCatalogFile {
  readonly descriptor: number;
  readonly descriptors: readonly number[];
  readonly canonicalRoot: string;
}

function catalogReadFailure(): CatalogValidationError {
  return new CatalogValidationError(
    "UNSAFE_SOURCE",
    "Catalog content could not be read safely",
  );
}

function catalogPathSegments(relativePath: string): readonly string[] {
  if (isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw catalogReadFailure();
  }
  const segments = relativePath.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0"),
    )
  ) {
    throw catalogReadFailure();
  }
  return segments;
}

function descriptorPath(descriptor: number): string {
  const resolved = readlinkSync(`/proc/self/fd/${String(descriptor)}`);
  if (resolved.endsWith(" (deleted)")) throw catalogReadFailure();
  return resolved;
}

function assertOpenedInsideRoot(
  descriptor: number,
  canonicalRoot: string,
  allowRoot: boolean,
): void {
  const resolved = descriptorPath(descriptor);
  if (
    (allowRoot && resolved === canonicalRoot) ||
    resolved.startsWith(`${canonicalRoot}${sep}`)
  ) {
    return;
  }
  throw catalogReadFailure();
}

function closeDescriptors(descriptors: readonly number[]): void {
  for (const descriptor of descriptors.toReversed()) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the original validation result while closing every descriptor.
    }
  }
}

function openCatalogFile(
  trustedRoot: string,
  relativePath: string,
): OpenedCatalogFile {
  const segments = catalogPathSegments(relativePath);
  const descriptors: number[] = [];
  try {
    const canonicalRoot = realpathSync.native(trustedRoot);
    const rootDescriptor = openSync(
      canonicalRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    descriptors.push(rootDescriptor);
    assertOpenedInsideRoot(rootDescriptor, canonicalRoot, true);

    let parentDescriptor = rootDescriptor;
    for (const [index, segment] of segments.entries()) {
      const final = index === segments.length - 1;
      const flags = final
        ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        : constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
      const descriptor = openSync(
        `/proc/self/fd/${String(parentDescriptor)}/${segment}`,
        flags,
      );
      descriptors.push(descriptor);
      assertOpenedInsideRoot(descriptor, canonicalRoot, false);
      if (!final && !fstatSync(descriptor).isDirectory()) {
        throw catalogReadFailure();
      }
      parentDescriptor = descriptor;
    }

    const descriptor = descriptors.at(-1);
    if (descriptor === undefined || !fstatSync(descriptor).isFile()) {
      throw catalogReadFailure();
    }
    return { descriptor, descriptors, canonicalRoot };
  } catch (error) {
    closeDescriptors(descriptors);
    if (error instanceof CatalogValidationError) throw error;
    throw catalogReadFailure();
  }
}

function sameOpenedObject(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function readCatalogBytes(
  trustedRoot: string,
  relativePath: string,
  maximumBytes: number,
  hooks: CatalogReadHooks = {},
): Buffer {
  assertCurrentRequestActive();
  const opened = openCatalogFile(trustedRoot, relativePath);
  try {
    assertCurrentRequestActive();
    const before = fstatSync(opened.descriptor);
    if (!before.isFile() || before.size < 0 || before.size > maximumBytes) {
      throw catalogReadFailure();
    }
    hooks.afterOpen?.(relativePath, opened.descriptor);
    assertCurrentRequestActive();
    const bytes = readFileSync(opened.descriptor);
    assertCurrentRequestActive();
    const after = fstatSync(opened.descriptor);
    assertOpenedInsideRoot(opened.descriptor, opened.canonicalRoot, false);
    if (bytes.byteLength !== before.size || !sameOpenedObject(before, after)) {
      throw catalogReadFailure();
    }

    assertCurrentRequestActive();
    const rebound = openCatalogFile(trustedRoot, relativePath);
    try {
      if (!sameOpenedObject(after, fstatSync(rebound.descriptor))) {
        throw catalogReadFailure();
      }
    } finally {
      closeDescriptors(rebound.descriptors);
    }
    return bytes;
  } catch (error) {
    if (error instanceof CatalogValidationError) throw error;
    throw catalogReadFailure();
  } finally {
    closeDescriptors(opened.descriptors);
  }
}

const skillMetadataSchema = z
  .object({
    id: z.string().regex(SKILL_ID_PATTERN).max(80),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(512),
    capabilities: z.array(z.string().min(1).max(80)).min(1).max(16),
    revision: z.string().regex(REVISION_PATTERN).max(128),
    trustAtPublication: z.literal("trusted"),
  })
  .strict();

const inventorySchema = z
  .array(skillMetadataSchema)
  .length(10)
  .superRefine((entries, context) => {
    const identifiers = entries.map((entry) => entry.id);
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: "custom",
        message: "Skill identifiers must be unique",
      });
    }
    const sorted = identifiers.toSorted((left, right) =>
      left.localeCompare(right, "en-US"),
    );
    if (identifiers.some((identifier, index) => identifier !== sorted[index])) {
      context.addIssue({
        code: "custom",
        message: "Inventory must be sorted by skill id",
      });
    }
  });

const publishedProvenanceSchema = z
  .object({
    source: z
      .object({
        provider: z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/)
          .max(64),
        reference: z.string().min(1).max(512),
      })
      .strict(),
    sourceRevision: z.string().min(1).max(128),
    owner: z.string().min(1).max(160),
    license: z.literal("Apache-2.0"),
    trustAtPublication: z.literal("trusted"),
  })
  .strict();

const sourceProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    skillId: z.string().regex(SKILL_ID_PATTERN),
    revision: z.string().regex(REVISION_PATTERN),
    publishedProvenance: publishedProvenanceSchema,
    resources: z
      .array(
        z
          .object({
            path: z.string().min(1).max(240),
            mediaType: z.enum(["text/markdown", "text/plain"]),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();

const manifestEntrySchema = z
  .object({
    path: z.string().min(1).max(240),
    mediaType: z.enum(["text/markdown", "text/plain"]),
    byteLength: z.number().int().min(0).max(262_144),
    sha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();

const publicationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    skillId: z.string().regex(SKILL_ID_PATTERN),
    revision: z.string().regex(REVISION_PATTERN),
    bundleSha256: z.string().regex(SHA256_PATTERN),
    publishedProvenance: publishedProvenanceSchema,
    instructionsSha256: z.string().regex(SHA256_PATTERN),
    resourceManifest: z.array(manifestEntrySchema).min(1).max(64),
    sourcePaths: z
      .object({
        instructions: z.string().min(1),
        provenance: z.string().min(1),
        resources: z.array(z.string().min(1)).min(1).max(64),
      })
      .strict(),
  })
  .strict();

const releaseRevisionSchema = z
  .object({
    skillId: z.string().regex(SKILL_ID_PATTERN),
    revision: z.string().regex(REVISION_PATTERN),
    bundleSha256: z.string().regex(SHA256_PATTERN),
    recordPath: z.string().regex(/^revisions\/[a-z0-9-]+\.json$/),
  })
  .strict();

const releaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseId: z.string().regex(SKILL_ID_PATTERN).max(96),
    genesis: z.boolean(),
    previousReleaseCommit: z.union([
      z.null(),
      z.string().regex(/^[0-9a-f]{40}$/),
    ]),
    inventorySha256: z.string().regex(SHA256_PATTERN),
    advisoryChainHead: z.string().regex(SHA256_PATTERN),
    revisionCount: z.literal(10),
    revisions: z.array(releaseRevisionSchema).length(10),
    publishedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((release, context) => {
    if (release.genesis && release.previousReleaseCommit !== null) {
      context.addIssue({
        code: "custom",
        message: "Genesis cannot have a previous release commit",
      });
    }
    if (!release.genesis && release.previousReleaseCommit === null) {
      context.addIssue({
        code: "custom",
        message: "Non-genesis requires a previous release commit",
      });
    }
  });

export function readCatalogText(
  trustedRoot: string,
  relativePath: string,
  maximumBytes = 262_144,
  hooks: CatalogReadHooks = {},
): string {
  return normalizeUtf8(
    readCatalogBytes(trustedRoot, relativePath, maximumBytes, hooks),
    maximumBytes,
  ).text;
}

function readJson(trustedRoot: string, relativePath: string): unknown {
  try {
    return JSON.parse(readCatalogText(trustedRoot, relativePath)) as unknown;
  } catch (error) {
    if (error instanceof CatalogValidationError) throw error;
    throw new CatalogValidationError(
      "INVALID_INPUT",
      "Catalog JSON is invalid",
    );
  }
}

export function loadCatalogMetadata(
  projectRoot = process.cwd(),
): readonly CatalogSkillInventoryEntry[] {
  const result = inventorySchema.safeParse(
    readJson(projectRoot, "catalog/inventory.json"),
  );
  if (!result.success) {
    throw new CatalogValidationError(
      "INVALID_INVENTORY",
      "Catalog inventory is invalid",
    );
  }
  return Object.freeze(
    result.data.map((entry) =>
      Object.freeze({
        ...entry,
        capabilities: Object.freeze(entry.capabilities),
      }),
    ),
  );
}

export function catalogInventorySha256(
  inventory: readonly CatalogSkillInventoryEntry[],
): string {
  return sha256Hex(canonicalJson(inventory));
}

export function loadSourceRevision(
  projectRoot: string,
  metadata: CatalogSkillInventoryEntry,
): SkillRevision {
  const revisionRoot = join(
    "catalog",
    "skills",
    metadata.id,
    metadata.revision,
  );
  const provenancePath = join(revisionRoot, "provenance.json");
  const parsed = sourceProvenanceSchema.safeParse(
    readJson(projectRoot, provenancePath),
  );
  if (!parsed.success) {
    throw new CatalogValidationError(
      "INVALID_PROVENANCE",
      "Published provenance is invalid",
    );
  }
  if (
    parsed.data.skillId !== metadata.id ||
    parsed.data.revision !== metadata.revision
  ) {
    throw new CatalogValidationError(
      "INVALID_PROVENANCE",
      "Provenance identity does not match inventory",
    );
  }

  const instructions = readCatalogText(
    projectRoot,
    join(revisionRoot, "SKILL.md"),
  );
  const resources = parsed.data.resources.map((resource) => {
    assertSafeResourcePath(resource.path);
    return {
      path: resource.path,
      mediaType: resource.mediaType,
      content: readCatalogText(projectRoot, join(revisionRoot, resource.path)),
    };
  });

  try {
    return createSkillRevision({
      skillId: metadata.id,
      revision: metadata.revision,
      publishedProvenance: parsed.data.publishedProvenance,
      instructions,
      resources,
    });
  } catch (error) {
    throw new CatalogValidationError(
      "INVALID_CONTENT",
      error instanceof Error ? error.message : "Catalog content is invalid",
    );
  }
}

export function loadSourceCatalog(
  projectRoot = process.cwd(),
): readonly SkillRevision[] {
  return loadCatalogMetadata(projectRoot).map((metadata) =>
    loadSourceRevision(projectRoot, metadata),
  );
}

export function publicationRecordFor(
  revision: SkillRevision,
): RevisionPublicationRecord {
  const sourceRoot = `catalog/skills/${revision.skillId}/${revision.revision}`;
  return {
    schemaVersion: 1,
    skillId: revision.skillId,
    revision: revision.revision,
    bundleSha256: revision.bundleSha256,
    publishedProvenance: revision.publishedProvenance,
    instructionsSha256: revision.instructionsSha256,
    resourceManifest: revision.resourceManifest,
    sourcePaths: {
      instructions: `${sourceRoot}/SKILL.md`,
      provenance: `${sourceRoot}/provenance.json`,
      resources: revision.resourceManifest.map(
        (resource) => `${sourceRoot}/${resource.path}`,
      ),
    },
  };
}

export interface LoadedPublishedCatalog {
  readonly inventory: readonly CatalogSkillInventoryEntry[];
  readonly metadata: readonly CatalogSkillMetadata[];
  readonly release: CatalogRelease;
  readonly revisions: readonly SkillRevision[];
  readonly advisoryChain: VerifiedAdvisoryChain;
}

export function loadPublishedRevisionHashes(
  projectRoot: string,
): ReadonlyMap<string, string> {
  const hashes = new Map<string, string>();
  const releasesRoot = join(projectRoot, "catalog", "releases");
  if (!existsSync(releasesRoot)) return hashes;

  for (const release of readdirSync(releasesRoot, { withFileTypes: true })) {
    if (!release.isDirectory() || release.name.startsWith(".")) continue;
    const revisionsRoot = join(releasesRoot, release.name, "revisions");
    if (!existsSync(revisionsRoot)) {
      throw new CatalogValidationError(
        "INVALID_RELEASE",
        "Published revision records are missing",
      );
    }
    for (const record of readdirSync(revisionsRoot, { withFileTypes: true })) {
      if (!record.isFile() || !record.name.endsWith(".json")) continue;
      const parsed = publicationRecordSchema.safeParse(
        readJson(
          projectRoot,
          join("catalog", "releases", release.name, "revisions", record.name),
        ),
      );
      if (!parsed.success) {
        throw new CatalogValidationError(
          "INVALID_RELEASE",
          "Revision publication record is invalid",
        );
      }
      const key = `${parsed.data.skillId}\0${parsed.data.revision}`;
      if (hashes.has(key)) {
        throw new CatalogValidationError(
          "INVALID_RELEASE",
          "Published revision identity is duplicated",
        );
      }
      hashes.set(key, parsed.data.bundleSha256);
    }
  }
  return hashes;
}

export function loadVerifiedAdvisoryChain(
  projectRoot: string,
  revisions: readonly SkillRevision[],
  expectedHead?: string,
): VerifiedAdvisoryChain {
  const serialized = normalizeUtf8(
    readCatalogBytes(projectRoot, "catalog/advisories.jsonl", 2 * 1024 * 1024),
    2 * 1024 * 1024,
  ).text;
  try {
    const revisionHashes = new Map(loadPublishedRevisionHashes(projectRoot));
    for (const revision of revisions) {
      const key = `${revision.skillId}\0${revision.revision}`;
      const publishedHash = revisionHashes.get(key);
      if (
        publishedHash !== undefined &&
        publishedHash !== revision.bundleSha256
      ) {
        throw new Error("Published revision hash does not match source");
      }
      revisionHashes.set(key, revision.bundleSha256);
    }
    return verifyAdvisoryChain(
      parseAdvisoryChain(serialized),
      revisionHashes,
      expectedHead,
    );
  } catch {
    throw new CatalogValidationError(
      "INVALID_ADVISORY_CHAIN",
      "Published advisory chain is invalid",
    );
  }
}

export function loadPublishedCatalog(
  projectRoot: string,
  releaseId: string,
): LoadedPublishedCatalog {
  const inventory = loadCatalogMetadata(projectRoot);
  const parsedRelease = releaseSchema.safeParse(
    readJson(
      projectRoot,
      join("catalog", "releases", releaseId, "release.json"),
    ),
  );
  if (!parsedRelease.success || parsedRelease.data.releaseId !== releaseId) {
    throw new CatalogValidationError(
      "INVALID_RELEASE",
      "Published release metadata is invalid",
    );
  }
  const release = parsedRelease.data;
  if (release.inventorySha256 !== catalogInventorySha256(inventory)) {
    throw new CatalogValidationError(
      "HASH_MISMATCH",
      "Inventory hash does not match release",
    );
  }

  const expectedSkillIds = inventory.map((entry) => entry.id);
  const releaseSkillIds = release.revisions.map((entry) => entry.skillId);
  if (
    releaseSkillIds.some(
      (skillId, index) => skillId !== expectedSkillIds[index],
    ) ||
    new Set(releaseSkillIds).size !== releaseSkillIds.length
  ) {
    throw new CatalogValidationError(
      "INVALID_RELEASE",
      "Release revision summary is invalid",
    );
  }

  const revisions = inventory.map((metadata, index) => {
    const summary = release.revisions[index];
    if (summary === undefined) {
      throw new CatalogValidationError(
        "INVALID_RELEASE",
        "Release revision is missing",
      );
    }
    const recordResult = publicationRecordSchema.safeParse(
      readJson(
        projectRoot,
        join("catalog", "releases", releaseId, summary.recordPath),
      ),
    );
    if (!recordResult.success) {
      throw new CatalogValidationError(
        "INVALID_RELEASE",
        "Revision publication record is invalid",
      );
    }
    const sourceRevision = loadSourceRevision(projectRoot, metadata);
    const expectedRecord = publicationRecordFor(sourceRevision);
    if (
      summary.revision !== sourceRevision.revision ||
      summary.bundleSha256 !== sourceRevision.bundleSha256 ||
      canonicalJson(recordResult.data) !== canonicalJson(expectedRecord)
    ) {
      throw new CatalogValidationError(
        "HASH_MISMATCH",
        "Published revision hash does not match source",
      );
    }
    return sourceRevision;
  });

  const releaseDirectories = readdirSync(
    join(projectRoot, "catalog", "releases"),
    {
      withFileTypes: true,
    },
  ).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  if (release.genesis && releaseDirectories.length !== 1) {
    throw new CatalogValidationError(
      "INVALID_RELEASE",
      "Genesis release must be the only local release",
    );
  }
  if (!release.genesis && releaseDirectories.length < 2) {
    throw new CatalogValidationError(
      "INVALID_RELEASE",
      "Non-genesis release requires an earlier local release",
    );
  }

  const advisoryChain = loadVerifiedAdvisoryChain(
    projectRoot,
    revisions,
    release.advisoryChainHead,
  );
  const metadata = inventory.map((entry) => ({
    ...entry,
    currentAdvisoryStatus: advisoryStatusFor(
      advisoryChain,
      entry.id,
      entry.revision,
    ),
  }));

  return { inventory, metadata, release, revisions, advisoryChain };
}
