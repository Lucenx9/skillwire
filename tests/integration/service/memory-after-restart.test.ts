import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { repositoryMemoryScope } from "../../../src/domain/repository-memory/types.js";
import { PostgresApiKeyStore } from "../../../src/persistence/postgres/api-key-store.js";
import { PostgresRepositoryMemoryStore } from "../../../src/persistence/postgres/repository-memory-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

const pepper = "restart-pepper-that-is-at-least-thirty-two-bytes";

describe("repository memory after service restart", () => {
  let database: TestDatabase;
  let accountId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    accountId = randomUUID();
    await new PostgresApiKeyStore(database.pool, pepper).createAccount(
      accountId,
    );
  }, 120_000);

  afterAll(async () => database.close());

  it("reads acknowledged usage through a new pool with no process cache", async () => {
    const scope = repositoryMemoryScope(accountId, "c".repeat(64));
    const firstPool = new Pool({ connectionString: database.connectionString });
    await new PostgresRepositoryMemoryStore(firstPool).recordUsage(scope, {
      skillId: "typescript-code-review",
      revision: "1.0.0",
      revisionSha256: "d".repeat(64),
    });
    await firstPool.end();

    const restartedPool = new Pool({
      connectionString: database.connectionString,
    });
    try {
      await expect(
        new PostgresRepositoryMemoryStore(restartedPool).list(scope),
      ).resolves.toMatchObject([
        { skillId: "typescript-code-review", usageCount: 1 },
      ]);
    } finally {
      await restartedPool.end();
    }
  });
});
