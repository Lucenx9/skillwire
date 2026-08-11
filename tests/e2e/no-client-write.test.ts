import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createApplication,
  createTestApplication,
} from "../../src/composition.js";
import type { SkillRevision } from "../../src/domain/catalog/types.js";
import { VerifiedRevisionCache } from "../../src/catalog/verified-revision-cache.js";
import { createApiKeyToken } from "../../src/authentication/api-key-token.js";
import { PostgresApiKeyStore } from "../../src/persistence/postgres/api-key-store.js";
import { snapshotTree } from "../helpers/filesystem-snapshot.js";
import {
  createTestMcpClient,
  TEST_BEARER_TOKEN,
  type TestMcpClient,
} from "../helpers/mcp-client.js";
import { createPublishedCatalogWithStatus } from "../helpers/catalog-cli.js";
import { createTestDatabase } from "../helpers/database.js";

const clientTree = fileURLToPath(
  new URL("../fixtures/client-tree/", import.meta.url),
);

async function directClient(
  projectRoot = process.cwd(),
  bearerToken = TEST_BEARER_TOKEN,
  options: Parameters<typeof createTestApplication>[0] = {},
): Promise<TestMcpClient> {
  const { app } = createTestApplication(options, projectRoot);
  const appFetch: typeof fetch = async (input, init) => {
    const source = new Request(input, init);
    const headers = new Headers(source.headers);
    headers.set("host", "localhost");
    return app.fetch(new Request(source, { headers }));
  };
  return createTestMcpClient(
    new URL("http://localhost/mcp"),
    appFetch,
    bearerToken,
  );
}

describe("remote delivery never mutates the client tree", () => {
  it("preserves bytes, entry types, and modes across success, failure, and retry", async () => {
    const before = await snapshotTree(clientTree);
    const client = await directClient();
    try {
      const search = await client.client.callTool({
        name: "search_skills",
        arguments: { task: "Review TypeScript type safety", limit: 1 },
      });
      expect(search.isError).not.toBe(true);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const load = await client.client.callTool({
          name: "load_skill",
          arguments: {
            skillId: "typescript-code-review",
            revision: "1.0.0",
          },
        });
        expect(load.isError).not.toBe(true);
      }
      const resource = await client.client.callTool({
        name: "read_skill_resource",
        arguments: {
          skillId: "typescript-code-review",
          revision: "1.0.0",
          path: "references/review-checklist.md",
        },
      });
      expect(resource.isError).not.toBe(true);
      const unknown = await client.client.callTool({
        name: "load_skill",
        arguments: {
          skillId: "typescript-code-review",
          revision: "9.9.9",
        },
      });
      expect(unknown.isError).toBe(true);
    } finally {
      await client.close();
    }
    expect(await snapshotTree(clientTree)).toBe(before);
  });

  it.each(["unavailable", "revoked"] as const)(
    "preserves the tree through %s advisory behavior",
    async (status) => {
      const before = await snapshotTree(clientTree);
      const workspace = createPublishedCatalogWithStatus(status);
      try {
        const client = await directClient(workspace);
        try {
          const result = await client.client.callTool({
            name: "load_skill",
            arguments: {
              skillId: "typescript-code-review",
              revision: "1.0.0",
            },
          });
          expect(result.isError === true).toBe(status === "revoked");
        } finally {
          await client.close();
        }
      } finally {
        rmSync(workspace, { recursive: true });
      }
      expect(await snapshotTree(clientTree)).toBe(before);
    },
  );

  it("preserves the tree when authentication fails", async () => {
    const before = await snapshotTree(clientTree);
    await expect(
      directClient(process.cwd(), "invalid-token"),
    ).rejects.toThrow();
    expect(await snapshotTree(clientTree)).toBe(before);
  });

  it("preserves the tree when an unavailable revision cache is corrupt", async () => {
    const before = await snapshotTree(clientTree);
    const workspace = createPublishedCatalogWithStatus("unavailable");
    const cache = new VerifiedRevisionCache();
    try {
      const client = await directClient(workspace, TEST_BEARER_TOKEN, {
        catalogCache: cache,
      });
      try {
        const entries = (
          cache as unknown as {
            entries: Map<string, SkillRevision>;
          }
        ).entries;
        for (const [key, revision] of entries) {
          if (revision.skillId === "typescript-code-review") {
            entries.set(key, {
              ...revision,
              instructions: `${revision.instructions}\ncorrupt cache`,
            });
          }
        }
        const result = await client.client.callTool({
          name: "load_skill",
          arguments: {
            skillId: "typescript-code-review",
            revision: "1.0.0",
          },
        });
        expect(result.isError).toBe(true);
      } finally {
        await client.close();
      }
    } finally {
      rmSync(workspace, { recursive: true });
    }
    expect(await snapshotTree(clientTree)).toBe(before);
  });

  it("preserves the tree through authenticated rate limiting", async () => {
    const before = await snapshotTree(clientTree);
    const client = await directClient(process.cwd(), TEST_BEARER_TOKEN, {
      rateLimit: {
        accountRequestsPerMinute: 1,
        apiKeyRequestsPerMinute: 1,
        burst: 2,
      },
    });
    try {
      await expect(
        client.client.callTool({
          name: "search_skills",
          arguments: { task: "TypeScript review" },
        }),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
    expect(await snapshotTree(clientTree)).toBe(before);
  });

  it("preserves the tree through idempotent PostgreSQL repository erasure", async () => {
    const before = await snapshotTree(clientTree);
    const database = await createTestDatabase();
    const pepper = "no-client-write-pepper-at-least-thirty-two-bytes";
    let application: Awaited<ReturnType<typeof createApplication>> | undefined;
    let client: TestMcpClient | undefined;
    try {
      await database.migrate();
      const accountId = randomUUID();
      const token = createApiKeyToken();
      const keys = new PostgresApiKeyStore(database.pool, pepper);
      await keys.createAccount(accountId);
      await keys.createKey(randomUUID(), accountId, token);
      application = await createApplication({
        host: "127.0.0.1",
        port: 0,
        databaseUrl: database.connectionString,
        apiKeyPepper: pepper,
      });
      const activeApplication = application;
      const appFetch: typeof fetch = async (input, init) => {
        const source = new Request(input, init);
        const headers = new Headers(source.headers);
        headers.set("host", "127.0.0.1");
        return activeApplication.app.fetch(new Request(source, { headers }));
      };
      client = await createTestMcpClient(
        new URL("http://127.0.0.1/mcp"),
        appFetch,
        token.token,
      );
      const repositoryHash = "e".repeat(64);
      await client.client.callTool({
        name: "load_skill",
        arguments: {
          skillId: "typescript-code-review",
          revision: "1.0.0",
          repositoryHash,
        },
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const erased = await client.client.callTool({
          name: "forget_repo_memory",
          arguments: { repositoryHash },
        });
        expect(erased.isError).not.toBe(true);
      }
      const memory = await client.client.callTool({
        name: "list_repo_memory",
        arguments: { repositoryHash },
      });
      expect(memory.structuredContent).toMatchObject({ entries: [] });
    } finally {
      await client?.close();
      await application?.close();
      await database.close();
    }
    expect(await snapshotTree(clientTree)).toBe(before);
  }, 120_000);
});
