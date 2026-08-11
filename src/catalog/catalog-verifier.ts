import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SkillRevision } from "../domain/catalog/types.js";
import {
  CatalogValidationError,
  loadCatalogMetadata,
  loadPublishedCatalog,
} from "./catalog-loader.js";
import { verifyGitHubReleaseBaseline } from "./github-release-baseline.js";

export interface CatalogVerificationOptions {
  readonly requireGitHubBaseline?: boolean | undefined;
  readonly repository?: string | undefined;
  readonly token?: string | undefined;
  readonly apiUrl?: string | undefined;
  readonly fetchImplementation?: typeof fetch | undefined;
}

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
  baselineMode: "genesis" | "non-genesis" = "genesis",
  previousReleaseCommit: string | null = null,
): CatalogVerifyResult["checks"] {
  return {
    inventory,
    release: false,
    publicationClaimAbsent,
    advisoryChain: false,
    githubBaseline: false,
    baselineMode,
    previousReleaseCommit,
    selectedGitHubReleaseId: null,
    selectedGitHubPublishedAt: null,
    resolvedPreviousReleaseCommit: null,
  };
}

export async function verifyCatalog(
  projectRoot: string,
  releaseId: string,
  options: CatalogVerificationOptions = {},
): Promise<CatalogVerifyResult> {
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
    const baselineMode = loaded.release.genesis ? "genesis" : "non-genesis";
    const requiresGitHub =
      options.requireGitHubBaseline === true || !loaded.release.genesis;
    let selectedGitHubReleaseId: number | null = null;
    let selectedGitHubPublishedAt: string | null = null;
    let resolvedPreviousReleaseCommit: string | null = null;
    if (requiresGitHub) {
      if (options.repository === undefined || options.token === undefined) {
        throw new CatalogValidationError(
          "GITHUB_BASELINE_UNAVAILABLE",
          "The exact GitHub release baseline is required",
        );
      }
      try {
        const baseline = await verifyGitHubReleaseBaseline({
          projectRoot,
          release: loaded.release,
          repository: options.repository,
          token: options.token,
          apiUrl: options.apiUrl,
          fetchImplementation: options.fetchImplementation,
        });
        selectedGitHubReleaseId = baseline.selectedGitHubReleaseId;
        selectedGitHubPublishedAt = baseline.selectedGitHubPublishedAt;
        resolvedPreviousReleaseCommit = baseline.resolvedPreviousReleaseCommit;
      } catch {
        throw new CatalogValidationError(
          "GITHUB_BASELINE_INVALID",
          "The exact GitHub release baseline could not be verified",
        );
      }
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
        baselineMode,
        previousReleaseCommit: loaded.release.previousReleaseCommit,
        selectedGitHubReleaseId,
        selectedGitHubPublishedAt,
        resolvedPreviousReleaseCommit,
      },
      revisions: verifiedRevisions(loaded.revisions),
      errors: [],
    };
  } catch (error) {
    let baselineMode: "genesis" | "non-genesis" = "genesis";
    let previousReleaseCommit: string | null = null;
    try {
      const release = loadPublishedCatalog(projectRoot, releaseId).release;
      baselineMode = release.genesis ? "genesis" : "non-genesis";
      previousReleaseCommit = release.previousReleaseCommit;
    } catch {
      // The original failure remains authoritative and safely summarized.
    }
    return {
      releaseId,
      valid: false,
      checks: failedChecks(
        inventoryValid,
        true,
        baselineMode,
        previousReleaseCommit,
      ),
      revisions: fallbackRevisions,
      errors: [
        error instanceof CatalogValidationError
          ? error.code
          : "INVALID_RELEASE",
      ],
    };
  }
}
