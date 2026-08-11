import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCatalogWorkspace,
  PROJECT_ROOT,
  runCatalogCommand,
} from "../../helpers/catalog-cli.js";
import { verifyCatalog } from "../../../src/catalog/catalog-verifier.js";
import {
  createGitHubApiStub,
  githubFixture,
} from "../../helpers/github-api-stub.js";
import { snapshotTree } from "../../helpers/filesystem-snapshot.js";

interface VerifyOutput {
  readonly releaseId: string;
  readonly valid: boolean;
  readonly revisions: readonly { readonly valid: boolean }[];
  readonly errors: readonly string[];
}

const previousCommit = "a".repeat(40);

function githubRoutes(genesis: boolean): Readonly<Record<string, unknown>> {
  const releasesPath =
    "/repos/skillwire/skillwire/releases?per_page=100&page=1";
  if (genesis) {
    return {
      [releasesPath]: githubFixture(PROJECT_ROOT, "no-published-releases.json"),
    };
  }
  return {
    [releasesPath]: githubFixture(PROJECT_ROOT, "published-releases.json"),
    "/repos/skillwire/skillwire/git/ref/tags/v1.0.0": githubFixture(
      PROJECT_ROOT,
      "lightweight-tag-ref.json",
    ),
    [`/repos/skillwire/skillwire/contents/catalog/advisories.jsonl?ref=${previousCommit}`]:
      githubFixture(PROJECT_ROOT, "previous-advisory-content.json"),
  };
}

function makeNonGenesis(workspace: string): void {
  const releasePath = join(
    workspace,
    "catalog/releases/launch-catalog-v1/release.json",
  );
  const release = JSON.parse(readFileSync(releasePath, "utf8")) as {
    genesis: boolean;
    previousReleaseCommit: string | null;
  };
  release.genesis = false;
  release.previousReleaseCommit = previousCommit;
  writeFileSync(releasePath, `${JSON.stringify(release)}\n`);
  mkdirSync(join(workspace, "catalog/releases/prior/revisions"), {
    recursive: true,
  });
}

function verifierModuleGraph(entry: string): readonly string[] {
  const visited = new Set<string>();
  const visit = (path: string): void => {
    const absolute = resolve(path);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const source = readFileSync(absolute, "utf8");
    for (const match of source.matchAll(
      /(?:from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/g,
    )) {
      const specifier = match[2];
      if (specifier === undefined) continue;
      const dependency = resolve(
        dirname(absolute),
        specifier.replace(/\.js$/, ".ts"),
      );
      visit(dependency);
    }
  };
  visit(entry);
  return [...visited];
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

  it("verifies exact GitHub baselines for genesis and non-genesis fixtures", async () => {
    const genesisWorkspace = createCatalogWorkspace();
    const nonGenesisWorkspace = createCatalogWorkspace();
    workspaces.push(genesisWorkspace, nonGenesisWorkspace);
    expect(runCatalogCommand(genesisWorkspace, "publish").status).toBe(0);
    expect(runCatalogCommand(nonGenesisWorkspace, "publish").status).toBe(0);
    makeNonGenesis(nonGenesisWorkspace);

    const genesisGitHub = createGitHubApiStub(githubRoutes(true));
    const genesis = await verifyCatalog(genesisWorkspace, "launch-catalog-v1", {
      requireGitHubBaseline: true,
      repository: "skillwire/skillwire",
      token: "read-only-token",
      apiUrl: "https://api.github.test",
      fetchImplementation: genesisGitHub.fetch,
    });
    expect(genesis.valid).toBe(true);
    expect(genesis.checks).toMatchObject({
      githubBaseline: true,
      baselineMode: "genesis",
      selectedGitHubReleaseId: null,
    });

    const nonGenesisGitHub = createGitHubApiStub(githubRoutes(false));
    const nonGenesis = await verifyCatalog(
      nonGenesisWorkspace,
      "launch-catalog-v1",
      {
        repository: "skillwire/skillwire",
        token: "read-only-token",
        apiUrl: "https://api.github.test",
        fetchImplementation: nonGenesisGitHub.fetch,
      },
    );
    expect(nonGenesis.valid).toBe(true);
    expect(nonGenesis.checks).toMatchObject({
      githubBaseline: true,
      baselineMode: "non-genesis",
      previousReleaseCommit: previousCommit,
      selectedGitHubReleaseId: 10,
      resolvedPreviousReleaseCommit: previousCommit,
    });
  });

  it("fails closed when a non-genesis baseline cannot be retrieved", async () => {
    const workspace = createCatalogWorkspace();
    workspaces.push(workspace);
    expect(runCatalogCommand(workspace, "publish").status).toBe(0);
    makeNonGenesis(workspace);

    const result = await verifyCatalog(workspace, "launch-catalog-v1");

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["GITHUB_BASELINE_UNAVAILABLE"]);
  });

  it("keeps the verifier module graph free of publisher and database capabilities", () => {
    const graph = verifierModuleGraph(
      join(PROJECT_ROOT, "src/catalog/verify-cli.ts"),
    );
    const relativeGraph = graph.map((path) => relative(PROJECT_ROOT, path));
    expect(relativeGraph).not.toContain("src/catalog/catalog-publisher.ts");
    expect(
      relativeGraph.some((path) => path.startsWith("src/ingestion/")),
    ).toBe(false);
    expect(
      relativeGraph.some((path) =>
        /(?:^|\/)(?:persistence|migrations)(?:\/|$)/.test(path),
      ),
    ).toBe(false);
    const source = graph.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(source).not.toMatch(
      /\b(?:writeFileSync|mkdirSync|renameSync|rmSync|rmdirSync)\b|from ["']pg["']/,
    );
  });

  it("runs the real verifier with workspace writes and network denied", async () => {
    const workspace = createCatalogWorkspace();
    workspaces.push(workspace);
    expect(runCatalogCommand(workspace, "publish").status).toBe(0);
    const buildRoot = join(workspace, "verifier-build");
    const build = spawnSync(
      join(PROJECT_ROOT, "node_modules/.bin/tsc"),
      ["-p", join(PROJECT_ROOT, "tsconfig.json"), "--outDir", buildRoot],
      { cwd: PROJECT_ROOT, encoding: "utf8" },
    );
    expect(build.status, build.stderr).toBe(0);
    symlinkSync(
      join(PROJECT_ROOT, "node_modules"),
      join(workspace, "node_modules"),
      "dir",
    );
    const before = await snapshotTree(workspace);

    const result = spawnSync(
      process.execPath,
      [
        join(buildRoot, "src/catalog/verify-cli.js"),
        "--release-id",
        "launch-catalog-v1",
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://forbidden.invalid/skillwire",
          NODE_OPTIONS: "--permission --allow-fs-read=*",
          SKILLWIRE_ROOT: workspace,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as VerifyOutput).valid).toBe(true);
    expect(await snapshotTree(workspace)).toBe(before);
  }, 20_000);

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
