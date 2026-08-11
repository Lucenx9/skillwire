import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { repositoryMemoryScope } from "../../../src/domain/repository-memory/types.js";
import { PostgresApiKeyStore } from "../../../src/persistence/postgres/api-key-store.js";
import { PostgresRepositoryMemoryStore } from "../../../src/persistence/postgres/repository-memory-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

const pepper = "security-pepper-that-is-at-least-thirty-two-bytes";
const sharedHash = "f".repeat(64);
const otherHash = "e".repeat(64);
const revisionSha256 = "d".repeat(64);

describe("repository-memory tenant isolation", () => {
  let database: TestDatabase;
  let store: PostgresRepositoryMemoryStore;
  let accountA: string;
  let accountB: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    store = new PostgresRepositoryMemoryStore(database.pool);
    const accounts = new PostgresApiKeyStore(database.pool, pepper);
    accountA = randomUUID();
    accountB = randomUUID();
    await accounts.createAccount(accountA);
    await accounts.createAccount(accountB);
    for (const [accountId, repositoryHash, skillId] of [
      [accountA, sharedHash, "typescript-code-review"],
      [accountA, otherHash, "node-api-design"],
      [accountB, sharedHash, "postgres-schema-review"],
    ] as const) {
      await store.recordUsage(
        repositoryMemoryScope(accountId, repositoryHash),
        {
          skillId,
          revision: "1.0.0",
          revisionSha256,
        },
      );
    }
  }, 120_000);

  afterAll(async () => database.close());

  it("scopes list, outcome, projection, and forget by account plus repository", async () => {
    const scopeA = repositoryMemoryScope(accountA, sharedHash);
    const scopeB = repositoryMemoryScope(accountB, sharedHash);
    expect((await store.list(scopeA)).map((row) => row.skillId)).toEqual([
      "typescript-code-review",
    ]);
    expect((await store.list(scopeB)).map((row) => row.skillId)).toEqual([
      "postgres-schema-review",
    ]);
    expect(
      await store.replaceOutcome(
        scopeA,
        "postgres-schema-review",
        "1.0.0",
        "useful",
      ),
    ).toBe(false);
    expect((await store.rankingProjection(scopeA))[0]?.skillId).toBe(
      "typescript-code-review",
    );

    await store.forget(scopeA, randomUUID());
    expect(await store.list(scopeA)).toEqual([]);
    expect(await store.list(scopeB)).toHaveLength(1);
    expect(
      await store.list(repositoryMemoryScope(accountA, otherHash)),
    ).toHaveLength(1);
  });
});
