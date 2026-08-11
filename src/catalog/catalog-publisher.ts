import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "../domain/catalog/canonical-revision.js";
import type { CatalogRelease, SkillRevision } from "../domain/catalog/types.js";
import {
  catalogInventorySha256,
  CatalogValidationError,
  loadCatalogMetadata,
  loadSourceCatalog,
  loadVerifiedAdvisoryChain,
  publicationRecordFor,
} from "./catalog-loader.js";

const RELEASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface PublishRevisionResult {
  readonly skillId: string;
  readonly revision: string | null;
  readonly bundleSha256: string | null;
  readonly recordPath: string | null;
  readonly status: "created" | "rejected";
  readonly code: string | null;
}

export interface CatalogPublishResult {
  readonly releaseId: string | null;
  readonly created: boolean;
  readonly releasePath: string | null;
  readonly revisions: readonly PublishRevisionResult[];
  readonly errors: readonly string[];
}

export interface PublishCatalogOptions {
  readonly projectRoot: string;
  readonly releaseId: string;
  readonly genesis: boolean;
  readonly previousReleaseCommit: string | null;
  readonly publishedAt?: string | undefined;
}

function publishedRevisionIdentities(releasesRoot: string): Set<string> {
  const identities = new Set<string>();
  if (!existsSync(releasesRoot)) return identities;
  for (const release of readdirSync(releasesRoot, { withFileTypes: true })) {
    if (!release.isDirectory() || release.name.startsWith(".")) continue;
    const revisionsPath = join(releasesRoot, release.name, "revisions");
    if (!existsSync(revisionsPath)) throw new Error("INVALID_RELEASE");
    for (const record of readdirSync(revisionsPath, { withFileTypes: true })) {
      if (!record.isFile() || !record.name.endsWith(".json")) continue;
      const value = JSON.parse(
        readFileSync(join(revisionsPath, record.name), "utf8"),
      ) as { skillId?: unknown; revision?: unknown };
      if (
        typeof value.skillId !== "string" ||
        typeof value.revision !== "string"
      ) {
        throw new Error("INVALID_RELEASE");
      }
      identities.add(`${value.skillId}\0${value.revision}`);
    }
  }
  return identities;
}

function syncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeCanonicalFile(path: string, value: unknown): void {
  writeFileSync(path, `${canonicalJson(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  syncPath(path);
}

function rejectedResults(
  revisions: readonly SkillRevision[],
  skillIds: readonly string[],
  releaseId: string | null,
  code: string,
): CatalogPublishResult {
  const revisionsBySkill = new Map(
    revisions.map((revision) => [revision.skillId, revision]),
  );
  return {
    releaseId,
    created: false,
    releasePath: null,
    revisions: skillIds.map((skillId) => {
      const revision = revisionsBySkill.get(skillId);
      return {
        skillId,
        revision: revision?.revision ?? null,
        bundleSha256: revision?.bundleSha256 ?? null,
        recordPath:
          releaseId === null || revision === undefined
            ? null
            : `catalog/releases/${releaseId}/revisions/${skillId}.json`,
        status: "rejected",
        code,
      };
    }),
    errors: [code],
  };
}

export function publishCatalog(
  options: PublishCatalogOptions,
): CatalogPublishResult {
  const validReleaseId =
    options.releaseId.length <= 96 && RELEASE_ID_PATTERN.test(options.releaseId)
      ? options.releaseId
      : null;
  let skillIds: readonly string[] = [];
  let revisions: readonly SkillRevision[] = [];
  try {
    const inventory = loadCatalogMetadata(options.projectRoot);
    skillIds = inventory.map((entry) => entry.id);
    revisions = loadSourceCatalog(options.projectRoot);
    loadVerifiedAdvisoryChain(options.projectRoot, revisions);
  } catch (error) {
    const code =
      error instanceof CatalogValidationError ? error.code : "INVALID_INPUT";
    return rejectedResults(revisions, skillIds, validReleaseId, code);
  }
  if (validReleaseId === null) {
    return rejectedResults(revisions, skillIds, null, "INVALID_INPUT");
  }

  const releasesRoot = join(options.projectRoot, "catalog", "releases");
  const claimPath = join(releasesRoot, ".publish-claim");
  const finalPath = join(releasesRoot, validReleaseId);
  const stagePath = join(
    releasesRoot,
    `.staging-${validReleaseId}-${randomUUID()}`,
  );
  let claimAcquired = false;
  let published = false;

  try {
    mkdirSync(releasesRoot, { recursive: true });
    mkdirSync(claimPath);
    claimAcquired = true;

    const existingReleases = readdirSync(releasesRoot, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
    if (existsSync(finalPath)) {
      return rejectedResults(
        revisions,
        skillIds,
        validReleaseId,
        "RELEASE_ALREADY_EXISTS",
      );
    }
    if (
      (options.genesis && existingReleases.length > 0) ||
      (!options.genesis && existingReleases.length === 0)
    ) {
      return rejectedResults(
        revisions,
        skillIds,
        validReleaseId,
        "INVALID_RELEASE",
      );
    }
    const publishedIdentities = publishedRevisionIdentities(releasesRoot);
    if (
      revisions.some((revision) =>
        publishedIdentities.has(`${revision.skillId}\0${revision.revision}`),
      )
    ) {
      return rejectedResults(
        revisions,
        skillIds,
        validReleaseId,
        "DUPLICATE_REVISION",
      );
    }

    mkdirSync(join(stagePath, "revisions"), { recursive: true });
    const releaseRevisions = revisions.map((revision) => {
      const record = publicationRecordFor(revision);
      writeCanonicalFile(
        join(stagePath, "revisions", `${revision.skillId}.json`),
        record,
      );
      return {
        skillId: revision.skillId,
        revision: revision.revision,
        bundleSha256: revision.bundleSha256,
        recordPath: `revisions/${revision.skillId}.json`,
      };
    });
    syncPath(join(stagePath, "revisions"));

    const advisoryChain = loadVerifiedAdvisoryChain(
      options.projectRoot,
      revisions,
    );
    const release: CatalogRelease = {
      schemaVersion: 1,
      releaseId: validReleaseId,
      genesis: options.genesis,
      previousReleaseCommit: options.previousReleaseCommit,
      inventorySha256: catalogInventorySha256(
        loadCatalogMetadata(options.projectRoot),
      ),
      advisoryChainHead: advisoryChain.head,
      revisionCount: 10,
      revisions: releaseRevisions,
      publishedAt: options.publishedAt ?? new Date().toISOString(),
    };
    writeCanonicalFile(join(stagePath, "release.json"), release);
    syncPath(stagePath);
    renameSync(stagePath, finalPath);
    published = true;
    syncPath(releasesRoot);

    return {
      releaseId: validReleaseId,
      created: true,
      releasePath: `catalog/releases/${validReleaseId}`,
      revisions: revisions.map((revision) => ({
        skillId: revision.skillId,
        revision: revision.revision,
        bundleSha256: revision.bundleSha256,
        recordPath: `catalog/releases/${validReleaseId}/revisions/${revision.skillId}.json`,
        status: "created",
        code: null,
      })),
      errors: [],
    };
  } catch (error) {
    const code =
      error instanceof Error && "code" in error && error.code === "EEXIST"
        ? "PUBLICATION_CLAIMED"
        : "PUBLICATION_FAILED";
    return rejectedResults(revisions, skillIds, validReleaseId, code);
  } finally {
    if (!published && existsSync(stagePath))
      rmSync(stagePath, { recursive: true, force: true });
    if (claimAcquired && existsSync(claimPath)) rmdirSync(claimPath);
  }
}
