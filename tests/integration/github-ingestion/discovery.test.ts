import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SourceDiscoveryService } from "../../../src/application/services/source-discovery-service.js";
import { GitHubCommitTreeBlobReader } from "../../../src/ingestion/github/commit-tree-blob-reader.js";
import { GitHubSearchDiscoveryProvider } from "../../../src/ingestion/github/discovery-provider.js";
import { GitHubRestClient } from "../../../src/ingestion/github/rest-client.js";
import { PostgresGitHubSourceStore } from "../../../src/persistence/postgres/github-source-store.js";
import { PostgresSyncLeaseStore } from "../../../src/persistence/postgres/sync-lease-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

describe("asynchronous source discovery", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
  }, 120_000);

  afterAll(async () => database.close());

  it("persists unique discovered public sources and reuses a validated ETag body", async () => {
    let searchCalls = 0;
    let conditionalCalls = 0;
    const fetchImplementation: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(url.origin).toBe("https://api.github.com");
      if (url.pathname === "/search/code") {
        searchCalls += 1;
        if (request.headers.get("if-none-match") === '"discovery-v1"') {
          conditionalCalls += 1;
          return Promise.resolve(new Response(null, { status: 304 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              total_count: 2,
              incomplete_results: false,
              items: [
                {
                  path: "a/SKILL.md",
                  repository: {
                    id: 2002,
                    name: "nested-skills",
                    private: false,
                    owner: { login: "fixture-org" },
                  },
                },
                {
                  path: "b/SKILL.md",
                  repository: {
                    id: 2002,
                    name: "nested-skills",
                    private: false,
                    owner: { login: "FIXTURE-ORG" },
                  },
                },
              ],
            }),
            { headers: { etag: '"discovery-v1"' } },
          ),
        );
      }
      if (
        url.pathname === "/repos/FIXTURE-ORG/nested-skills" ||
        url.pathname === "/repos/fixture-org/nested-skills"
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 2002,
              name: "nested-skills",
              private: false,
              default_branch: "main",
              owner: { login: "fixture-org" },
            }),
          ),
        );
      }
      throw new Error("unexpected fixture route");
    };
    const store = new PostgresGitHubSourceStore(database.pool);
    const reader = new GitHubCommitTreeBlobReader(
      new GitHubRestClient({ fetchImplementation }),
    );
    const search = new GitHubSearchDiscoveryProvider(
      new GitHubRestClient({ fetchImplementation }),
      {
        querySetId: "recognized-layouts-v1",
        queries: [
          { query: "filename:SKILL.md", evidenceKind: "nested-skill-document" },
        ],
        maximumQueries: 1,
        maximumPagesPerQuery: 1,
        resultsPerPage: 100,
        maximumResults: 100,
        maximumRequests: 10,
        maximumResponseBytes: 65_536,
      },
      store,
    );
    const service = new SourceDiscoveryService(
      search,
      reader,
      store,
      "recognized-layouts-v1",
      {
        maximumQueries: 1,
        maximumPages: 1,
        maximumResults: 100,
        maximumRequests: 10,
        maximumResponseBytes: 65_536,
      },
    );
    const leases = new PostgresSyncLeaseStore(database.pool);
    let lastRunId = "";
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const run = await service.enqueue();
      expect(run.created).toBe(true);
      lastRunId = run.runId;
      const lease = await leases.acquire("discovery", randomUUID(), 5000);
      if (lease === undefined) throw new Error("discovery lease missing");
      await service.execute(run.runId, lease);
      await leases.release(lease);
    }
    await expect(service.enqueueScheduled(3_600_000)).resolves.toEqual({
      runId: lastRunId,
      state: "succeeded",
      created: false,
    });
    expect(searchCalls).toBe(2);
    expect(conditionalCalls).toBe(1);
    const sources = await database.pool.query<{
      github_repository_id: string;
      source_classification: string;
    }>(
      "SELECT github_repository_id, source_classification FROM github_sources",
    );
    expect(sources.rows).toEqual([
      { github_repository_id: "2002", source_classification: "discovered" },
    ]);
    const evidence = await database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM github_discovery_evidence",
    );
    expect(evidence.rows[0]?.count).toBe("4");
    await expect(store.listSources()).resolves.toEqual([]);
    const administrativeSources =
      await store.listAdministrativeSources("discovered");
    expect(administrativeSources).toHaveLength(1);
    expect(administrativeSources[0]).toMatchObject({
      classification: "discovered",
      registered: false,
      repository: { repositoryId: 2002 },
    });
  });

  it("is absent from every agent-facing MCP request graph", async () => {
    const paths = [
      "src/composition.ts",
      "src/application/use-cases/search-skills.ts",
      "src/transport/mcp/tool-adapters.ts",
    ];
    for (const path of paths) {
      const source = await readFile(path, "utf8");
      expect(source).not.toMatch(
        /source-discovery-service|GitHubSearchDiscoveryProvider/,
      );
    }
  });
});
