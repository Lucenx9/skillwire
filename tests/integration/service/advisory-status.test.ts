import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { loadVerifiedCatalogProvider } from "../../../src/catalog/version-controlled-provider.js";
import { VerifiedRevisionCache } from "../../../src/catalog/verified-revision-cache.js";
import {
  createPublishedCatalogWithStatus,
  PROJECT_ROOT,
} from "../../helpers/catalog-cli.js";

describe("runtime advisory status", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true });
    }
  });

  it("derives unavailable separately and serves the reverified immutable cache", () => {
    const original = loadVerifiedCatalogProvider(
      PROJECT_ROOT,
      "launch-catalog-v1",
    ).findRevision("typescript-code-review", "1.0.0");
    const workspace = createPublishedCatalogWithStatus("unavailable");
    workspaces.push(workspace);
    const provider = loadVerifiedCatalogProvider(
      workspace,
      "launch-catalog-v1",
    );
    const loaded = provider.findRevision("typescript-code-review", "1.0.0");

    expect(provider.advisoryStatus("typescript-code-review", "1.0.0")).toBe(
      "unavailable",
    );
    expect(loaded?.bundleSha256).toBe(original?.bundleSha256);
    expect(loaded?.publishedProvenance.trustAtPublication).toBe("trusted");
  });

  it("keeps trust immutable while refusing a revoked revision", () => {
    const workspace = createPublishedCatalogWithStatus("revoked");
    workspaces.push(workspace);
    const provider = loadVerifiedCatalogProvider(
      workspace,
      "launch-catalog-v1",
    );
    const metadata = provider
      .listMetadata()
      .find((entry) => entry.id === "typescript-code-review");

    expect(metadata).toMatchObject({
      trustAtPublication: "trusted",
      currentAdvisoryStatus: "revoked",
    });
    expect(
      provider.findRevision("typescript-code-review", "1.0.0"),
    ).toBeUndefined();
  });

  it("fails closed when an unavailable exact revision has no retained cache entry", () => {
    const workspace = createPublishedCatalogWithStatus("unavailable");
    workspaces.push(workspace);
    const provider = loadVerifiedCatalogProvider(
      workspace,
      "launch-catalog-v1",
      new VerifiedRevisionCache(1),
    );

    expect(
      provider.findRevision("typescript-code-review", "1.0.0"),
    ).toBeUndefined();
    expect(provider.findRevision("vitest-test-design", "1.0.0")).toBeDefined();
  });
});
