import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  canonicalJson,
  createSkillRevision,
  sha256Hex,
} from "../domain/catalog/canonical-revision.js";
import { resolveResourcePath } from "../domain/catalog/resource-path.js";
import { normalizeUtf8 } from "../domain/catalog/text-normalization.js";
import type {
  CatalogRelease,
  CatalogSkillMetadata,
  RevisionPublicationRecord,
  SkillRevision,
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

const skillMetadataSchema = z
  .object({
    id: z.string().regex(SKILL_ID_PATTERN).max(80),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(512),
    capabilities: z.array(z.string().min(1).max(80)).min(1).max(16),
    revision: z.string().regex(REVISION_PATTERN).max(128),
    trustAtPublication: z.literal("trusted"),
    currentAdvisoryStatus: z.literal("available"),
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
    genesis: z.literal(true),
    previousReleaseCommit: z.null(),
    inventorySha256: z.string().regex(SHA256_PATTERN),
    revisionCount: z.literal(10),
    revisions: z.array(releaseRevisionSchema).length(10),
    publishedAt: z.iso.datetime(),
  })
  .strict();

function readNormalizedFile(path: string): string {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new CatalogValidationError(
      "UNSAFE_SOURCE",
      "Catalog content must be a regular file",
    );
  }
  return normalizeUtf8(readFileSync(path)).text;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readNormalizedFile(path)) as unknown;
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
): readonly CatalogSkillMetadata[] {
  const result = inventorySchema.safeParse(
    readJson(join(projectRoot, "catalog", "inventory.json")),
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
  inventory: readonly CatalogSkillMetadata[],
): string {
  return sha256Hex(canonicalJson(inventory));
}

export function loadSourceRevision(
  projectRoot: string,
  metadata: CatalogSkillMetadata,
): SkillRevision {
  const revisionRoot = join(
    projectRoot,
    "catalog",
    "skills",
    metadata.id,
    metadata.revision,
  );
  const provenancePath = join(revisionRoot, "provenance.json");
  const parsed = sourceProvenanceSchema.safeParse(readJson(provenancePath));
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

  const instructions = readNormalizedFile(join(revisionRoot, "SKILL.md"));
  const resources = parsed.data.resources.map((resource) => {
    const absolutePath = resolveResourcePath(revisionRoot, resource.path);
    return {
      path: resource.path,
      mediaType: resource.mediaType,
      content: readNormalizedFile(absolutePath),
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
  readonly inventory: readonly CatalogSkillMetadata[];
  readonly release: CatalogRelease;
  readonly revisions: readonly SkillRevision[];
}

export function loadPublishedCatalog(
  projectRoot: string,
  releaseId: string,
): LoadedPublishedCatalog {
  const inventory = loadCatalogMetadata(projectRoot);
  const releaseRoot = join(projectRoot, "catalog", "releases", releaseId);
  const parsedRelease = releaseSchema.safeParse(
    readJson(join(releaseRoot, "release.json")),
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
      readJson(join(releaseRoot, summary.recordPath)),
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
  if (releaseDirectories.length !== 1) {
    throw new CatalogValidationError(
      "INVALID_RELEASE",
      "Genesis release must be the only local release",
    );
  }

  return { inventory, release, revisions };
}
