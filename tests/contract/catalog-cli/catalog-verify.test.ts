import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCatalogWorkspace,
  PROJECT_ROOT,
  runCatalogCommand,
} from "../../helpers/catalog-cli.js";
import { snapshotTree } from "../../helpers/filesystem-snapshot.js";

interface VerifyOutput {
  readonly releaseId: string;
  readonly valid: boolean;
  readonly revisions: readonly { readonly valid: boolean }[];
  readonly errors: readonly string[];
}

describe("catalog:verify", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0))
      rmSync(workspace, { recursive: true });
  });

  it("recomputes the complete published batch without writing", async () => {
    const workspace = createCatalogWorkspace();
    workspaces.push(workspace);
    expect(runCatalogCommand(workspace, "publish").status).toBe(0);
    const before = await snapshotTree(workspace);

    const result = runCatalogCommand(workspace, "verify");

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as VerifyOutput;
    expect(output.valid).toBe(true);
    expect(output.revisions).toHaveLength(10);
    expect(output.revisions.every((revision) => revision.valid)).toBe(true);
    expect(output.errors).toEqual([]);
    expect(await snapshotTree(workspace)).toBe(before);
  });

  it("wires and runs read-only advisory verification", async () => {
    const packageJson = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["advisory:verify"]).toBe(
      "tsx src/catalog/advisory-verify-cli.ts",
    );
    const before = await snapshotTree(join(PROJECT_ROOT, "catalog"));
    const result = spawnSync(
      process.execPath,
      [
        join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
        join(PROJECT_ROOT, "src", "catalog", "advisory-verify-cli.ts"),
        "--release-id",
        "launch-catalog-v1",
      ],
      { cwd: PROJECT_ROOT, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      releaseId: "launch-catalog-v1",
      valid: true,
      eventCount: 10,
    });
    expect(await snapshotTree(join(PROJECT_ROOT, "catalog"))).toBe(before);
  });

  it("rejects a resource hash mismatch without repairing or writing", async () => {
    const workspace = createCatalogWorkspace();
    workspaces.push(workspace);
    expect(runCatalogCommand(workspace, "publish").status).toBe(0);
    const resourcePath = join(
      workspace,
      "catalog/skills/typescript-code-review/1.0.0/references/review-checklist.md",
    );
    writeFileSync(
      resourcePath,
      `${readFileSync(resourcePath, "utf8")}\nTampered.\n`,
    );
    const before = await snapshotTree(workspace);

    const result = runCatalogCommand(workspace, "verify");

    expect(result.status).not.toBe(0);
    expect((JSON.parse(result.stdout) as VerifyOutput).valid).toBe(false);
    expect(await snapshotTree(workspace)).toBe(before);
  });
});
