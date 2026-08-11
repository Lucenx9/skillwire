import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCatalogWorkspace,
  PROJECT_ROOT,
  runCatalogCommand,
} from "../../helpers/catalog-cli.js";
import { snapshotTree } from "../../helpers/filesystem-snapshot.js";

interface PublishOutput {
  readonly releaseId: string | null;
  readonly created: boolean;
  readonly releasePath: string | null;
  readonly revisions: readonly {
    readonly skillId: string;
    readonly status: string;
  }[];
  readonly errors: readonly string[];
}

describe("catalog:publish", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0))
      rmSync(workspace, { recursive: true });
  });

  it("is wired to the exact offline CLI subcommand", () => {
    const packageJson = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["catalog:publish"]).toBe(
      "tsx src/catalog/admin-cli.ts publish",
    );
    expect(packageJson.scripts["catalog:verify"]).toBe(
      "tsx src/catalog/admin-cli.ts verify",
    );
  });

  it("publishes all ten revisions atomically and never overwrites them", async () => {
    const workspace = createCatalogWorkspace();
    workspaces.push(workspace);

    const first = runCatalogCommand(workspace, "publish");
    expect(first.status, first.stderr).toBe(0);
    const output = JSON.parse(first.stdout) as PublishOutput;
    expect(output).toMatchObject({
      releaseId: "launch-catalog-v1",
      created: true,
      releasePath: "catalog/releases/launch-catalog-v1",
      errors: [],
    });
    expect(output.revisions).toHaveLength(10);
    expect(
      output.revisions.every((revision) => revision.status === "created"),
    ).toBe(true);

    const publishedSnapshot = await snapshotTree(workspace);
    const second = runCatalogCommand(workspace, "publish");
    expect(second.status).not.toBe(0);
    expect((JSON.parse(second.stdout) as PublishOutput).created).toBe(false);
    expect(await snapshotTree(workspace)).toBe(publishedSnapshot);
  });

  it("exposes no release when any source content is invalid", () => {
    const workspace = createCatalogWorkspace();
    workspaces.push(workspace);
    writeFileSync(
      join(
        workspace,
        "catalog/skills/typescript-code-review/1.0.0/references/review-checklist.md",
      ),
      Buffer.from([0xff, 0xfe]),
    );

    const result = runCatalogCommand(workspace, "publish");

    expect(result.status).not.toBe(0);
    expect(
      existsSync(join(workspace, "catalog/releases/launch-catalog-v1")),
    ).toBe(false);
  });
});
