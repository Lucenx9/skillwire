import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiKeyToken } from "../../src/authentication/api-key-token.js";
import { createApplication, type Application } from "../../src/composition.js";
import { PostgresApiKeyStore } from "../../src/persistence/postgres/api-key-store.js";
import {
  forgetRepoMemoryOutputSchema,
  listRepoMemoryOutputSchema,
  recordSkillOutcomeOutputSchema,
} from "../../src/transport/mcp/schemas.js";
import { createTestDatabase, type TestDatabase } from "../helpers/database.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../helpers/mcp-client.js";

const pepper = "e2e-pepper-that-is-at-least-thirty-two-bytes";
const repositoryHash = "c".repeat(64);

describe("outcome replacement and privacy-safe erasure journey", () => {
  let database: TestDatabase;
  let application: Application;
  let server: Server;
  let client: TestMcpClient;
  let bearerToken: string;

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
    const address = server.address() as AddressInfo;
    client = await createTestMcpClient(
      new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
      undefined,
      bearerToken,
    );
  }

  async function stopApplication(): Promise<void> {
    await client.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await application.close();
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    const accountId = randomUUID();
    const key = createApiKeyToken();
    const accounts = new PostgresApiKeyStore(database.pool, pepper);
    await accounts.createAccount(accountId);
    await accounts.createKey(randomUUID(), accountId, key);
    bearerToken = key.token;
    await startApplication();
  }, 120_000);

  afterAll(async () => {
    await stopApplication();
    await database.close();
  });

  it("replaces outcomes, erases before acknowledgement, and hides prior existence", async () => {
    await client.client.callTool({
      name: "load_skill",
      arguments: {
        skillId: "typescript-code-review",
        revision: "1.0.0",
        repositoryHash,
      },
    });
    for (const outcome of ["useful", "neutral", "unsuccessful"] as const) {
      expect(
        recordSkillOutcomeOutputSchema.parse(
          (
            await client.client.callTool({
              name: "record_skill_outcome",
              arguments: {
                repositoryHash,
                skillId: "typescript-code-review",
                revision: "1.0.0",
                outcome,
              },
            })
          ).structuredContent,
        ).outcome,
      ).toBe(outcome);
    }
    const before = listRepoMemoryOutputSchema.parse(
      (
        await client.client.callTool({
          name: "list_repo_memory",
          arguments: { repositoryHash },
        })
      ).structuredContent,
    );
    expect(before.entries).toMatchObject([{ outcome: "unsuccessful" }]);

    const first = forgetRepoMemoryOutputSchema.parse(
      (
        await client.client.callTool({
          name: "forget_repo_memory",
          arguments: { repositoryHash },
        })
      ).structuredContent,
    );
    const liveRows = await database.pool.query<{ count: string }>(
      "SELECT count(*) FROM repository_skill_usage WHERE repository_hash = $1",
      [repositoryHash],
    );
    expect(liveRows.rows[0]?.count).toBe("0");
    const second = forgetRepoMemoryOutputSchema.parse(
      (
        await client.client.callTool({
          name: "forget_repo_memory",
          arguments: { repositoryHash },
        })
      ).structuredContent,
    );
    expect(first).toEqual({ forgotten: true });
    expect(second).toEqual(first);
    expect(
      listRepoMemoryOutputSchema.parse(
        (
          await client.client.callTool({
            name: "list_repo_memory",
            arguments: { repositoryHash },
          })
        ).structuredContent,
      ).entries,
    ).toEqual([]);

    await stopApplication();
    await startApplication();
    expect(
      listRepoMemoryOutputSchema.parse(
        (
          await client.client.callTool({
            name: "list_repo_memory",
            arguments: { repositoryHash },
          })
        ).structuredContent,
      ).entries,
    ).toEqual([]);
  });
});
