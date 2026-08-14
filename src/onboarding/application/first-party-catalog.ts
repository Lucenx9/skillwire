import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { verifyCatalog } from "../../catalog/catalog-verifier.js";
import { loadVerifiedCatalogProvider } from "../../catalog/version-controlled-provider.js";
import type { SkillCatalogProvider } from "../../application/ports/skill-catalog-provider.js";
import type { ReleaseManifest } from "../domain/release-manifest.js";

const RELEASE_ID = "launch-catalog-v1";

export interface BundledCatalogReleaseIdentity {
  readonly payload: ReleaseManifest["payload"];
  readonly components: Pick<ReleaseManifest["components"], "catalog">;
}

export interface FirstPartyCatalogVerification {
  readonly releaseId: typeof RELEASE_ID;
  readonly provider: SkillCatalogProvider;
  readonly revisions: readonly {
    readonly skillId: string;
    readonly revision: string;
    readonly bundleSha256: string;
    readonly trustAtPublication: "trusted";
    readonly advisoryStatus: "available" | "unavailable" | "revoked";
  }[];
  readonly advisoryHeadSha256: string;
}

function aggregateCatalogPayload(payload: ReleaseManifest["payload"]): string {
  const entries = payload.filter(({ path }) => path.startsWith("catalog/"));
  if (entries.length === 0)
    throw new Error("Bundled catalog inventory is empty");
  const lines = entries
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .map(
      ({ path, size, sha256, mode }) =>
        `${path}\t${String(size)}\t${sha256}\t${mode}\n`,
    )
    .join("");
  return createHash("sha256").update(lines).digest("hex");
}

export async function verifyBundledFirstPartyCatalog(options: {
  readonly releaseRoot: string;
  readonly release: BundledCatalogReleaseIdentity;
  readonly fetchImplementation?: typeof fetch | undefined;
}): Promise<FirstPartyCatalogVerification> {
  const { catalog } = options.release.components;
  if (aggregateCatalogPayload(options.release.payload) !== catalog.sha256) {
    throw new Error(
      "Bundled catalog release identity does not match the manifest",
    );
  }
  const advisoryEntry = options.release.payload.find(
    ({ path }) => path === "catalog/advisories.jsonl",
  );
  if (advisoryEntry?.sha256 !== catalog.advisorySha256) {
    throw new Error("Bundled advisory identity does not match the manifest");
  }
  const advisoryBytes = await readFile(
    resolve(options.releaseRoot, advisoryEntry.path),
  );
  if (
    createHash("sha256").update(advisoryBytes).digest("hex") !==
    catalog.advisorySha256
  ) {
    throw new Error("Bundled advisory bytes failed release verification");
  }

  const result = await verifyCatalog(options.releaseRoot, RELEASE_ID, {
    requireGitHubBaseline: false,
    fetchImplementation: options.fetchImplementation,
  });
  if (
    !result.valid ||
    result.revisions.length !== 10 ||
    result.revisions.some(({ valid }) => !valid) ||
    !Object.values(result.checks).every(
      (value) => typeof value !== "boolean" || value,
    )
  ) {
    throw new Error("Bundled catalog or advisory verification failed");
  }

  const provider = loadVerifiedCatalogProvider(options.releaseRoot, RELEASE_ID);
  const metadata = provider.listMetadata();
  if (
    metadata.length !== 10 ||
    new Set(metadata.map(({ id }) => id)).size !== 10 ||
    metadata.some(
      ({ currentAdvisoryStatus }) =>
        currentAdvisoryStatus === "revoked" ||
        currentAdvisoryStatus === "unavailable",
    )
  ) {
    throw new Error("First-party catalog eligibility is invalid");
  }
  const resultById = new Map(
    result.revisions.map((revision) => [revision.skillId, revision]),
  );
  return Object.freeze({
    releaseId: RELEASE_ID,
    provider,
    revisions: Object.freeze(
      metadata.map((entry) => {
        const verified = resultById.get(entry.id);
        if (
          verified?.revision !== entry.revision ||
          verified.bundleSha256 !==
            provider.findRevision(entry.id, entry.revision)?.bundleSha256
        ) {
          throw new Error("First-party revision identity is inconsistent");
        }
        return Object.freeze({
          skillId: entry.id,
          revision: entry.revision,
          bundleSha256: verified.bundleSha256,
          trustAtPublication: "trusted" as const,
          advisoryStatus: entry.currentAdvisoryStatus,
        });
      }),
    ),
    advisoryHeadSha256: catalog.advisorySha256,
  });
}
