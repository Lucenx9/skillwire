import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { GitHubSearchDiscoveryProvider } from "../../../src/ingestion/github/discovery-provider.js";
import { requiredBlob } from "../../../src/application/services/source-synchronization-service.js";
import { GitHubRestClient } from "../../../src/ingestion/github/rest-client.js";
import { extractTextualResourceReferences } from "../../../src/ingestion/parsing/markdown-resources.js";
import { createTestDatabase } from "../../helpers/database.js";

describe("GitHub acquisition security boundaries", () => {
  it("rejects alternate-origin redirects and pagination without fetching them", async () => {
    const calls: string[] = [];
    const client = new GitHubRestClient({
      fetchImplementation: (input) => {
        calls.push(input instanceof Request ? input.url : input.toString());
        return Promise.resolve(
          new Response(null, {
            status: 301,
            headers: { location: "https://evil.example/repositories/7" },
          }),
        );
      },
    });
    await expect(
      client.resolvePublicRepository({
        owner: "safe-owner",
        repository: "safe-repo",
      }),
    ).rejects.toThrow("REDIRECT_REJECTED");
    expect(calls).toEqual([
      "https://api.github.com/repos/safe-owner/safe-repo",
    ]);

    const discovery = new GitHubSearchDiscoveryProvider(
      new GitHubRestClient({
        fetchImplementation: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                total_count: 0,
                incomplete_results: false,
                items: [],
              }),
              {
                headers: {
                  link: '<https://evil.example/search/code?page=2>; rel="next"',
                },
              },
            ),
          ),
      }),
      {
        querySetId: "safe",
        queries: [
          { query: "filename:SKILL.md", evidenceKind: "nested-skill-document" },
        ],
        maximumQueries: 1,
        maximumPagesPerQuery: 2,
        resultsPerPage: 1,
        maximumResults: 2,
        maximumRequests: 2,
        maximumResponseBytes: 4096,
      },
    );
    await expect(discovery.discover()).rejects.toThrow("PAGINATION_INVALID");
  });

  it("rejects traversal and never interprets remote or executable links as resources", () => {
    expect(() =>
      extractTextualResourceReferences(
        "[escape](..%2f..%2fsecret.md)",
        "a/SKILL.md",
      ),
    ).toThrow("PATH_UNSAFE");
    expect(
      extractTextualResourceReferences(
        "[remote](https://evil.example/a.md) [script](install.sh) [safe](guide.md)",
        "a/SKILL.md",
      ),
    ).toEqual([
      {
        manifestPath: "guide.md",
        repositoryPath: "a/guide.md",
        mediaType: "text/markdown",
      },
    ]);
  });

  it("contains no repository execution, cloning, checkout, or filesystem materialization path", async () => {
    const files = [
      "src/ingestion/github/rest-client.ts",
      "src/ingestion/github/commit-tree-blob-reader.ts",
      "src/ingestion/github/discovery-provider.ts",
      "src/application/services/source-synchronization-service.ts",
      "src/ingestion/parsing/nested-skill-layout.ts",
    ];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(
        /node:child_process|(?<!\.)\bspawn\s*\(|(?<!\.)\bexec(File)?\s*\(/,
      );
      expect(source).not.toMatch(
        /git\s+(clone|checkout)|writeFile|createWriteStream|package manager/i,
      );
    }
  });

  it.each([
    ["symlink", "120000", "blob"],
    ["executable", "100755", "blob"],
    ["submodule", "160000", "commit"],
    ["tree", "040000", "tree"],
  ] as const)(
    "rejects declared %s objects without reading them",
    (_label, mode, type) => {
      expect(() =>
        requiredBlob(
          [
            {
              path: "skills/example/SKILL.md",
              mode,
              type,
              sha: "1".repeat(40),
              ...(type === "blob" ? { size: 10 } : {}),
            },
          ],
          "skills/example/SKILL.md",
          1024,
        ),
      ).toThrow("OBJECT_UNSUPPORTED");
    },
  );

  it("rejects misleading GitHub media types before parsing a body", async () => {
    const client = new GitHubRestClient({
      fetchImplementation: () =>
        Promise.resolve(
          new Response("not-json", {
            headers: { "content-type": "application/octet-stream" },
          }),
        ),
    });
    await expect(
      client.resolvePublicRepository({
        owner: "safe-owner",
        repository: "safe-repo",
      }),
    ).rejects.toThrow("GITHUB_SCHEMA_INVALID");
  });

  it("keeps required CI offline and the PostgreSQL live import explicitly manual", async () => {
    const requiredCi = await readFile(".github/workflows/ci.yml", "utf8");
    expect(requiredCi).toContain('SKILLWIRE_BLOCK_GITHUB_NETWORK: "true"');
    expect(requiredCi).not.toMatch(/catalog:verify[^\n]*--github/);
    expect(requiredCi).not.toMatch(/advisory:verify[^\n]*--github/);
    const composeTest = await readFile("compose.test.yaml", "utf8");
    expect(composeTest).toContain('SKILLWIRE_BLOCK_GITHUB_NETWORK: "true"');
    const live = await readFile(
      ".github/workflows/github-live-smoke.yml",
      "utf8",
    );
    expect(live).toContain("workflow_dispatch:");
    expect(live).toContain("run_live_github:");
    expect(live).toContain("postgres:");
    expect(live).toContain("pnpm smoke:github-live");
    const smoke = await readFile("scripts/smoke-github-live.ts", "utf8");
    expect(smoke).toContain("ACCEPTANCE_COMMIT");
    expect(smoke).toContain("imported.traces.length !== 25");
    expect(smoke).toContain("imported.resourceCount !== 21");
    expect(smoke).not.toMatch(/writeFile|appendFile|rename\(/);
  });

  it("rejects live GitHub while retaining PostgreSQL access in the test boundary", async () => {
    await expect(
      fetch("https://api.github.com/repos/mattpocock/skills"),
    ).rejects.toThrow("UNEXPECTED_LIVE_GITHUB_REQUEST");
    const database = await createTestDatabase();
    try {
      await database.migrate();
      await expect(
        database.pool.query("SELECT 1 AS ready"),
      ).resolves.toMatchObject({ rows: [{ ready: 1 }] });
    } finally {
      await database.close();
    }
  }, 120_000);
});
