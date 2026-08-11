import { describe, expect, it } from "vitest";

import { GitHubSearchDiscoveryProvider } from "../../../src/ingestion/github/discovery-provider.js";
import { GitHubRestClient } from "../../../src/ingestion/github/rest-client.js";

function searchResponse(
  items: readonly {
    id: number;
    owner: string;
    repository: string;
    path: string;
  }[],
  options: { incomplete?: boolean; link?: string; etag?: string } = {},
): Response {
  return new Response(
    JSON.stringify({
      total_count: items.length,
      incomplete_results: options.incomplete ?? false,
      items: items.map((item) => ({
        path: item.path,
        repository: {
          id: item.id,
          name: item.repository,
          private: false,
          owner: { login: item.owner },
        },
      })),
    }),
    {
      headers: {
        ...(options.link === undefined ? {} : { link: options.link }),
        ...(options.etag === undefined ? {} : { etag: options.etag }),
      },
    },
  );
}

describe("GitHub search discovery provider", () => {
  it("uses server-controlled queries, validates pagination, and deduplicates repository IDs", async () => {
    const calls: URL[] = [];
    const provider = new GitHubSearchDiscoveryProvider(
      new GitHubRestClient({
        fetchImplementation: (input) => {
          const url = new URL(
            input instanceof Request ? input.url : input.toString(),
          );
          calls.push(url);
          if (url.searchParams.get("page") === "1") {
            return Promise.resolve(
              searchResponse(
                [
                  {
                    id: 7,
                    owner: "Acme",
                    repository: "Skills",
                    path: "a/SKILL.md",
                  },
                  {
                    id: 7,
                    owner: "acme",
                    repository: "skills",
                    path: "b/SKILL.md",
                  },
                ],
                {
                  link: `<https://api.github.com/search/code?q=filename%3ASKILL.md&per_page=2&page=2>; rel="next"`,
                },
              ),
            );
          }
          return Promise.resolve(
            searchResponse([
              { id: 8, owner: "Acme", repository: "More", path: "SKILL.md" },
            ]),
          );
        },
      }),
      {
        querySetId: "recognized-v1",
        queries: [
          { query: "filename:SKILL.md", evidenceKind: "nested-skill-document" },
        ],
        maximumQueries: 1,
        maximumPagesPerQuery: 2,
        resultsPerPage: 2,
        maximumResults: 3,
        maximumRequests: 2,
        maximumResponseBytes: 16_384,
      },
    );

    const result = await provider.discover();
    expect(result.hints.map(({ repositoryId }) => repositoryId)).toEqual([
      7, 8,
    ]);
    expect(result.evidence).toHaveLength(3);
    expect(result.incomplete).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls.every((url) => url.origin === "https://api.github.com")).toBe(
      true,
    );
  });

  it("fails closed on hostile Link targets and reports incomplete searches", async () => {
    const hostile = new GitHubSearchDiscoveryProvider(
      new GitHubRestClient({
        fetchImplementation: () =>
          Promise.resolve(
            searchResponse([], {
              link: '<https://evil.example/search/code?page=2>; rel="next"',
            }),
          ),
      }),
      {
        querySetId: "recognized-v1",
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
    await expect(hostile.discover()).rejects.toThrow("PAGINATION_INVALID");

    const incomplete = new GitHubSearchDiscoveryProvider(
      new GitHubRestClient({
        fetchImplementation: () =>
          Promise.resolve(searchResponse([], { incomplete: true })),
      }),
      {
        querySetId: "recognized-v1",
        queries: [
          { query: "filename:SKILL.md", evidenceKind: "nested-skill-document" },
        ],
        maximumQueries: 1,
        maximumPagesPerQuery: 1,
        resultsPerPage: 1,
        maximumResults: 1,
        maximumRequests: 1,
        maximumResponseBytes: 4096,
      },
    );
    await expect(incomplete.discover()).resolves.toMatchObject({
      incomplete: true,
    });
  });

  it("enforces query, pagination, result, request, and response-byte budgets", async () => {
    const client = new GitHubRestClient({
      fetchImplementation: () =>
        Promise.resolve(
          searchResponse([
            { id: 7, owner: "Acme", repository: "One", path: "a/SKILL.md" },
            { id: 8, owner: "Acme", repository: "Two", path: "b/SKILL.md" },
          ]),
        ),
    });
    const base = {
      querySetId: "recognized-v1",
      queries: [
        {
          query: "filename:SKILL.md",
          evidenceKind: "nested-skill-document" as const,
        },
      ],
      maximumQueries: 1,
      maximumPagesPerQuery: 1,
      resultsPerPage: 2,
      maximumResults: 2,
      maximumRequests: 1,
      maximumResponseBytes: 4096,
    };

    expect(
      () =>
        new GitHubSearchDiscoveryProvider(client, {
          ...base,
          queries: [...base.queries, ...base.queries],
        }),
    ).toThrow("INVALID_DISCOVERY_CONFIGURATION");
    await expect(
      new GitHubSearchDiscoveryProvider(client, {
        ...base,
        maximumResults: 1,
      }).discover(),
    ).rejects.toThrow("RESULT_BUDGET_EXCEEDED");
    await expect(
      new GitHubSearchDiscoveryProvider(client, {
        ...base,
        maximumResponseBytes: 8,
      }).discover(),
    ).rejects.toThrow("RESPONSE_BUDGET_EXCEEDED");

    const paginatedClient = new GitHubRestClient({
      fetchImplementation: () =>
        Promise.resolve(
          searchResponse([], {
            link: `<https://api.github.com/search/code?q=filename%3ASKILL.md&per_page=2&page=2>; rel="next"`,
          }),
        ),
    });
    await expect(
      new GitHubSearchDiscoveryProvider(paginatedClient, base).discover(),
    ).rejects.toThrow("PAGINATION_BUDGET_EXCEEDED");

    const twoQueries = {
      ...base,
      queries: [
        ...base.queries,
        {
          query: "path:.claude-plugin",
          evidenceKind: "claude-plugin-manifest" as const,
        },
      ],
      maximumQueries: 2,
    };
    await expect(
      new GitHubSearchDiscoveryProvider(
        new GitHubRestClient({
          fetchImplementation: () => Promise.resolve(searchResponse([])),
        }),
        twoQueries,
      ).discover(),
    ).rejects.toThrow("REQUEST_BUDGET_EXCEEDED");
  });
});
