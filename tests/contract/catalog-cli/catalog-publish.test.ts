import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { publishCatalog } from "../../../src/catalog/catalog-publisher.js";
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

function runConcurrentPublish(workspace: string): Promise<PublishOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
        join(PROJECT_ROOT, "src", "catalog", "admin-cli.ts"),
        "publish",
        "--release-id",
        "launch-catalog-v1",
        "--genesis",
      ],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, SKILLWIRE_ROOT: workspace },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", () => {
      try {
        resolve(JSON.parse(stdout) as PublishOutput);
      } catch {
        reject(new Error(`Invalid publisher output: ${stderr}`));
      }
    });
  });
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
    expect((JSON.parse(result.stdout) as PublishOutput).revisions).toHaveLength(
      10,
    );
  });

  it("fails closed on an existing publication claim without removing it", () => {
    const workspace = createCatalogWorkspace();
    workspaces.push(workspace);
    const claim = join(workspace, "catalog", "releases", ".publish-claim");
    mkdirSync(claim, { recursive: true });

    const result = runCatalogCommand(workspace, "publish");
    const output = JSON.parse(result.stdout) as PublishOutput;

    expect(result.status).not.toBe(0);
    expect(output.errors).toEqual(["PUBLICATION_CLAIMED"]);
    expect(output.revisions).toHaveLength(10);
    expect(existsSync(claim)).toBe(true);
    expect(
      existsSync(join(workspace, "catalog/releases/launch-catalog-v1")),
    ).toBe(false);
  });

  it("allows exactly one complete winner under concurrent publication", async () => {
    const workspace = createCatalogWorkspace();
    workspaces.push(workspace);

    const results = await Promise.all([
      runConcurrentPublish(workspace),
      runConcurrentPublish(workspace),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(1);
    expect(results.every((result) => result.revisions.length === 10)).toBe(
      true,
    );
    expect(
      existsSync(join(workspace, "catalog/releases/launch-catalog-v1")),
    ).toBe(true);
  });

  it("keeps a complete release truthful when post-rename claim cleanup fails", () => {
    const workspace = createCatalogWorkspace();
    workspaces.push(workspace);

    const output = publishCatalog({
      projectRoot: workspace,
      releaseId: "launch-catalog-v1",
      genesis: true,
      previousReleaseCommit: null,
      publishedAt: "2026-08-11T12:00:00.000Z",
      removePublicationClaim: () => {
        throw new Error("injected cleanup failure");
      },
    });

    expect(output.created).toBe(true);
    expect(output.revisions).toHaveLength(10);
    expect(
      existsSync(join(workspace, "catalog/releases/launch-catalog-v1")),
    ).toBe(true);
    expect(existsSync(join(workspace, "catalog/releases/.publish-claim"))).toBe(
      true,
    );
  });
});
