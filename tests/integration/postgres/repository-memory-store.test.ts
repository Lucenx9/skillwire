import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { repositoryMemoryScope } from "../../../src/domain/repository-memory/types.js";
import { PostgresApiKeyStore } from "../../../src/persistence/postgres/api-key-store.js";
import { PostgresRepositoryMemoryStore } from "../../../src/persistence/postgres/repository-memory-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

const pepper = "integration-pepper-that-is-at-least-thirty-two-bytes";
const repositoryHash = "a".repeat(64);
const revisionSha256 = "b".repeat(64);

describe("authoritative PostgreSQL repository memory", () => {
  let database: TestDatabase;
  let store: PostgresRepositoryMemoryStore;
  let accountId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    accountId = randomUUID();
    await new PostgresApiKeyStore(database.pool, pepper).createAccount(
      accountId,
    );
    store = new PostgresRepositoryMemoryStore(database.pool);
  }, 120_000);

  afterAll(async () => database.close());

  it("aggregates count and timestamps for one account/repository/revision", async () => {
    const scope = repositoryMemoryScope(accountId, repositoryHash);
    await store.recordUsage(scope, {
      skillId: "typescript-code-review",
      revision: "1.0.0",
      revisionSha256,
    });
    await store.recordUsage(scope, {
      skillId: "typescript-code-review",
      revision: "1.0.0",
      revisionSha256,
    });

    const entries = await store.list(scope);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      skillId: "typescript-code-review",
      revision: "1.0.0",
      revisionSha256,
      usageCount: 2,
    });
    expect(Date.parse(entries[0]?.firstUsedAt ?? "")).not.toBeNaN();
    expect(Date.parse(entries[0]?.lastUsedAt ?? "")).not.toBeNaN();
  });

  it("replaces outcomes and returns a direct ranking projection", async () => {
    const scope = repositoryMemoryScope(accountId, repositoryHash);
    expect(
      await store.replaceOutcome(
        scope,
        "typescript-code-review",
        "1.0.0",
        "neutral",
      ),
    ).toBe(true);
    expect(
      await store.replaceOutcome(
        scope,
        "typescript-code-review",
        "1.0.0",
        "useful",
      ),
    ).toBe(true);

    expect((await store.list(scope))[0]?.outcome).toBe("useful");
    expect(await store.rankingProjection(scope)).toEqual([
      {
        skillId: "typescript-code-review",
        revision: "1.0.0",
        outcome: "useful",
      },
    ]);
    expect(
      await store.replaceOutcome(scope, "unknown-skill", "1.0.0", "useful"),
    ).toBe(false);
  });
});
