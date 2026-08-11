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
      checks: {
        inventory: inventoryValid,
        release: false,
        publicationClaimAbsent,
      },
      revisions: fallbackRevisions,
      errors: ["PUBLICATION_CLAIMED"],
    };
  }

  try {
    const loaded = loadPublishedCatalog(projectRoot, releaseId);
    return {
      releaseId,
      valid: true,
      checks: { inventory: true, release: true, publicationClaimAbsent: true },
      revisions: verifiedRevisions(loaded.revisions),
      errors: [],
    };
  } catch (error) {
    return {
      releaseId,
      valid: false,
      checks: {
        inventory: inventoryValid,
        release: false,
        publicationClaimAbsent: true,
      },
      revisions: fallbackRevisions,
      errors: [
        error instanceof CatalogValidationError
          ? error.code
          : "INVALID_RELEASE",
      ],
    };
  }
}
