import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadVerifiedCatalogProvider } from "../../../src/catalog/version-controlled-provider.js";

describe("catalog benchmark cache modes", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true });
    }
  });

  it("re-verifies on each cold operation while warm operations remain preloaded", () => {
    const workspace = mkdtempSync(join(tmpdir(), "skillwire-cache-mode-"));
    workspaces.push(workspace);
    cpSync(join(process.cwd(), "catalog"), join(workspace, "catalog"), {
      recursive: true,
    });
    const warm = loadVerifiedCatalogProvider(
      workspace,
      "launch-catalog-v1",
      undefined,
      "catalog-warm",
    );
    const cold = loadVerifiedCatalogProvider(
      workspace,
      "launch-catalog-v1",
      undefined,
      "catalog-cold",
    );
    writeFileSync(
      join(workspace, "catalog/inventory.json"),
      "invalid catalog after startup\n",
    );

    expect(warm.listMetadata()).toHaveLength(10);
    expect(() => cold.listMetadata()).toThrow();
    expect(warm.findRevision("typescript-code-review", "1.0.0")?.skillId).toBe(
      "typescript-code-review",
    );
    expect(() =>
      cold.findRevision("typescript-code-review", "1.0.0"),
    ).toThrow();
  });
});
