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
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const revisionSha256 = "c".repeat(64);

describe("transactional repository erasure", () => {
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
  }, 120_000);

  afterAll(async () => database.close());

  const seed = (accountId: string, repositoryHash: string, skillId: string) =>
    store.recordUsage(repositoryMemoryScope(accountId, repositoryHash), {
      skillId,
      revision: "1.0.0",
      revisionSha256,
    });

  it("deletes only one tenant scope and inserts a six-field privacy-safe audit row", async () => {
    await seed(accountA, hashA, "typescript-code-review");
    await seed(accountA, hashB, "node-api-design");
    await seed(accountB, hashA, "postgres-schema-review");

    await store.forget(repositoryMemoryScope(accountA, hashA), randomUUID());

    expect(await store.list(repositoryMemoryScope(accountA, hashA))).toEqual(
      [],
    );
    expect(
      await store.list(repositoryMemoryScope(accountA, hashB)),
    ).toHaveLength(1);
    expect(
      await store.list(repositoryMemoryScope(accountB, hashA)),
    ).toHaveLength(1);

    const columns = await database.pool.query<{ column_name: string }>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'repository_erasure_audit'
        ORDER BY ordinal_position
      `,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "account_id",
      "request_id",
      "created_at",
      "expires_at",
      "operation_result",
      "removed_record_count",
    ]);
    const audit = await database.pool.query<{
      account_id: string;
      operation_result: string;
      removed_record_count: number;
      exact_expiry: boolean;
    }>(
      `
        SELECT
          account_id,
          operation_result,
          removed_record_count,
          expires_at = created_at + interval '30 days' AS exact_expiry
        FROM repository_erasure_audit
        WHERE account_id = $1
      `,
      [accountA],
    );
    expect(audit.rows).toEqual([
      {
        account_id: accountA,
        operation_result: "forgotten",
        removed_record_count: 1,
        exact_expiry: true,
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(hashA);
  });

  it("is idempotent for an empty scope", async () => {
    const empty = repositoryMemoryScope(accountA, "d".repeat(64));
    await store.forget(empty, randomUUID());
    await store.forget(empty, randomUUID());
    expect(await store.list(empty)).toEqual([]);
  });

  it("rolls deletion back when audit insertion fails", async () => {
    const scope = repositoryMemoryScope(accountA, "e".repeat(64));
    const requestId = randomUUID();
    await seed(accountA, scope.repositoryHash, "vitest-test-design");
    await store.forget(scope, requestId);
    await seed(accountA, scope.repositoryHash, "vitest-test-design");

    await expect(store.forget(scope, requestId)).rejects.toThrow();
    expect(await store.list(scope)).toHaveLength(1);
  });
});
