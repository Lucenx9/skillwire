import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApplication, type Application } from "../../src/composition.js";
import { createApiKeyToken } from "../../src/authentication/api-key-token.js";
import { PostgresApiKeyStore } from "../../src/persistence/postgres/api-key-store.js";
import {
  listRepoMemoryOutputSchema,
  loadSkillOutputSchema,
  recordSkillOutcomeOutputSchema,
  searchSkillsOutputSchema,
} from "../../src/transport/mcp/schemas.js";
import { createTestDatabase, type TestDatabase } from "../helpers/database.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../helpers/mcp-client.js";

const pepper = "e2e-pepper-that-is-at-least-thirty-two-bytes";
const repositoryA = "a".repeat(64);
const repositoryB = "b".repeat(64);

describe("PostgreSQL repository-memory MCP journey", () => {
  let database: TestDatabase;
  let application: Application;
  let server: Server;
  let accountAKey: string;
  let accountBKey: string;
  const clients: TestMcpClient[] = [];

  async function startApplication(): Promise<void> {
    application = await createApplication({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: database.connectionString,
      apiKeyPepper: pepper,
    });
    server = serve({
      fetch: application.app.fetch,
      hostname: "127.0.0.1",
      port: 0,
    }) as Server;
    await new Promise<void>((resolve) => server.once("listening", resolve));
  }

  async function stopApplication(): Promise<void> {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await application.close();
  }

  async function client(token: string): Promise<TestMcpClient> {
    const address = server.address() as AddressInfo;
    const connected = await createTestMcpClient(
      new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
      undefined,
      token,
    );
    clients.push(connected);
    return connected;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    const accounts = new PostgresApiKeyStore(database.pool, pepper);
    const accountA = randomUUID();
    const accountB = randomUUID();
    await accounts.createAccount(accountA);
    await accounts.createAccount(accountB);
    const keyA = createApiKeyToken();
    const keyB = createApiKeyToken();
    await accounts.createKey(randomUUID(), accountA, keyA);
    await accounts.createKey(randomUUID(), accountB, keyB);
    accountAKey = keyA.token;
    accountBKey = keyB.token;
    await startApplication();
  }, 120_000);

  afterAll(async () => {
    await stopApplication();
    await database.close();
  });

  it("records only contextual loads and isolates repository and account scopes", async () => {
    const accountA = await client(accountAKey);
    for (let index = 0; index < 2; index += 1) {
      const loaded = loadSkillOutputSchema.parse(
        (
          await accountA.client.callTool({
            name: "load_skill",
            arguments: {
              skillId: "typescript-code-review",
              revision: "1.0.0",
              repositoryHash: repositoryA,
            },
          })
        ).structuredContent,
      );
      expect(loaded.memoryRecorded).toBe(true);
    }
    const withoutMemory = loadSkillOutputSchema.parse(
      (
        await accountA.client.callTool({
          name: "load_skill",
          arguments: { skillId: "node-api-design", revision: "1.0.0" },
        })
      ).structuredContent,
    );
    expect(withoutMemory.memoryRecorded).toBe(false);

    const list = async (connected: TestMcpClient, repositoryHash: string) =>
      listRepoMemoryOutputSchema.parse(
        (
          await connected.client.callTool({
            name: "list_repo_memory",
            arguments: { repositoryHash },
          })
        ).structuredContent,
      ).entries;

    expect(await list(accountA, repositoryA)).toMatchObject([
      { skillId: "typescript-code-review", usageCount: 2 },
    ]);
    expect(await list(accountA, repositoryB)).toEqual([]);
    expect(await list(await client(accountBKey), repositoryA)).toEqual([]);
  });

  it("reads the current outcome directly for bounded repository ranking", async () => {
    const accountA = await client(accountAKey);
    await accountA.client.callTool({
      name: "load_skill",
      arguments: {
        skillId: "vitest-test-design",
        revision: "1.0.0",
        repositoryHash: repositoryB,
      },
    });
    expect(
      recordSkillOutcomeOutputSchema.parse(
        (
          await accountA.client.callTool({
            name: "record_skill_outcome",
            arguments: {
              repositoryHash: repositoryB,
              skillId: "vitest-test-design",
              revision: "1.0.0",
              outcome: "useful",
            },
          })
        ).structuredContent,
      ).outcome,
    ).toBe("useful");

    const ranked = searchSkillsOutputSchema.parse(
      (
        await accountA.client.callTool({
          name: "search_skills",
          arguments: {
            task: "quuxxyzzy",
            repositoryHash: repositoryB,
            limit: 10,
          },
        })
      ).structuredContent,
    );
    expect(ranked.skills[0]?.skillId).toBe("vitest-test-design");
  });

  it("persists acknowledged memory across a complete service restart", async () => {
    await stopApplication();
    await startApplication();

    const restarted = await client(accountAKey);
    const output = listRepoMemoryOutputSchema.parse(
      (
        await restarted.client.callTool({
          name: "list_repo_memory",
          arguments: { repositoryHash: repositoryA },
        })
      ).structuredContent,
    );
    expect(output.entries).toMatchObject([
      { skillId: "typescript-code-review", usageCount: 2 },
    ]);
  });
});
