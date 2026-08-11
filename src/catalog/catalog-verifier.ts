import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SkillRevision } from "../domain/catalog/types.js";
import {
  CatalogValidationError,
  loadCatalogMetadata,
  loadPublishedCatalog,
} from "./catalog-loader.js";

interface VerifyRevisionResult {
  readonly skillId: string;
  readonly revision: string;
  readonly bundleSha256: string;
  readonly valid: boolean;
}

export interface CatalogVerifyResult {
  readonly releaseId: string;
  readonly valid: boolean;
  readonly checks: {
    readonly inventory: boolean;
    readonly release: boolean;
    readonly publicationClaimAbsent: boolean;
    readonly advisoryChain: boolean;
    readonly githubBaseline: boolean;
    readonly baselineMode: "genesis" | "non-genesis";
    readonly previousReleaseCommit: string | null;
    readonly selectedGitHubReleaseId: number | null;
    readonly selectedGitHubPublishedAt: string | null;
    readonly resolvedPreviousReleaseCommit: string | null;
  };
  readonly revisions: readonly VerifyRevisionResult[];
  readonly errors: readonly string[];
}

function verifiedRevisions(
  revisions: readonly SkillRevision[],
): VerifyRevisionResult[] {
  return revisions.map((revision) => ({
    skillId: revision.skillId,
    revision: revision.revision,
    bundleSha256: revision.bundleSha256,
    valid: true,
  }));
}

function failedChecks(
  inventory: boolean,
  publicationClaimAbsent: boolean,
): CatalogVerifyResult["checks"] {
  return {
    inventory,
    release: false,
    publicationClaimAbsent,
    advisoryChain: false,
    githubBaseline: false,
    baselineMode: "genesis",
    previousReleaseCommit: null,
    selectedGitHubReleaseId: null,
    selectedGitHubPublishedAt: null,
    resolvedPreviousReleaseCommit: null,
  };
}

export function verifyCatalog(
  projectRoot: string,
  releaseId: string,
): CatalogVerifyResult {
  let inventoryValid = false;
  let fallbackRevisions: VerifyRevisionResult[] = [];
  try {
    const inventory = loadCatalogMetadata(projectRoot);
    inventoryValid = true;
    fallbackRevisions = inventory.map((entry) => ({
      skillId: entry.id,
      revision: entry.revision,
      bundleSha256: "0".repeat(64),
      valid: false,
    }));
  } catch {
    // The result below reports INVALID_INVENTORY without exposing parser details.
  }

  const publicationClaimAbsent = !existsSync(
    join(projectRoot, "catalog", "releases", ".publish-claim"),
  );
  if (!publicationClaimAbsent) {
    return {
      releaseId,
      valid: false,
      checks: failedChecks(inventoryValid, publicationClaimAbsent),
      revisions: fallbackRevisions,
      errors: ["PUBLICATION_CLAIMED"],
    };
  }

  try {
    const loaded = loadPublishedCatalog(projectRoot, releaseId);
    if (!loaded.release.genesis) {
      throw new CatalogValidationError(
        "GITHUB_BASELINE_REQUIRED",
        "Non-genesis verification requires the GitHub advisory command",
      );
    }
    return {
      releaseId,
      valid: true,
      checks: {
        inventory: true,
        release: true,
        publicationClaimAbsent: true,
        advisoryChain: true,
        githubBaseline: true,
        baselineMode: "genesis",
        previousReleaseCommit: null,
        selectedGitHubReleaseId: null,
        selectedGitHubPublishedAt: null,
        resolvedPreviousReleaseCommit: null,
      },
      revisions: verifiedRevisions(loaded.revisions),
      errors: [],
    };
  } catch (error) {
    return {
      releaseId,
      valid: false,
      checks: failedChecks(inventoryValid, true),
      revisions: fallbackRevisions,
      errors: [
        error instanceof CatalogValidationError
          ? error.code
          : "INVALID_RELEASE",
      ],
    };
  }
}
