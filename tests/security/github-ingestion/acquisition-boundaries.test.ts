import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { GitHubSearchDiscoveryProvider } from "../../../src/ingestion/github/discovery-provider.js";
import { GitHubRestClient } from "../../../src/ingestion/github/rest-client.js";
import { extractTextualResourceReferences } from "../../../src/ingestion/parsing/markdown-resources.js";

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
});
