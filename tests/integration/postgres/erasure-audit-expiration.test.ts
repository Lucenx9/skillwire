import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresApiKeyStore } from "../../../src/persistence/postgres/api-key-store.js";
import { PostgresErasureAuditStore } from "../../../src/persistence/postgres/erasure-audit-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

const pepper = "integration-pepper-that-is-at-least-thirty-two-bytes";

describe("erasure-audit expiration", () => {
  let database: TestDatabase;
  let store: PostgresErasureAuditStore;
  let accountId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    accountId = randomUUID();
    await new PostgresApiKeyStore(database.pool, pepper).createAccount(
      accountId,
    );
    store = new PostgresErasureAuditStore(database.pool);
  }, 120_000);

  afterAll(async () => database.close());

  async function insertAudit(age: string): Promise<string> {
    const requestId = randomUUID();
    await database.pool.query(
      `
        INSERT INTO repository_erasure_audit (
          account_id,
          request_id,
          created_at,
          expires_at,
          operation_result,
          removed_record_count
        ) VALUES (
          $1,
          $2,
          statement_timestamp() - $3::interval,
          statement_timestamp() - $3::interval + interval '30 days',
          'forgotten',
          0
        )
      `,
      [accountId, requestId, age],
    );
    return requestId;
  }

  it("excludes expired events from every application read before cleanup", async () => {
    const active = await insertAudit("29 days");
    const expired = await insertAudit("31 days");

    expect(
      (await store.listActive(accountId)).map((row) => row.requestId),
    ).toEqual([active]);
    expect(JSON.stringify(await store.listActive(accountId))).not.toContain(
      expired,
    );
  });

  it("deletes expired rows idempotently", async () => {
    await insertAudit("31 days");
    expect(await store.deleteExpired()).toBeGreaterThan(0);
    expect(await store.deleteExpired()).toBe(0);
    const remainingExpired = await database.pool.query<{ count: string }>(
      `
        SELECT count(*)
        FROM repository_erasure_audit
        WHERE expires_at <= statement_timestamp()
      `,
    );
    expect(remainingExpired.rows[0]?.count).toBe("0");
  });

  it("includes only rows strictly before their exact expiration boundary", async () => {
    const future = randomUUID();
    const atBoundary = randomUUID();
    const expired = randomUUID();
    await database.pool.query(
      `
        WITH boundary AS (SELECT statement_timestamp() AS now)
        INSERT INTO repository_erasure_audit (
          account_id,
          request_id,
          created_at,
          expires_at,
          operation_result,
          removed_record_count
        )
        SELECT $1, request_id, expires_at - interval '30 days', expires_at, 'forgotten', 0
        FROM boundary
        CROSS JOIN LATERAL (VALUES
          ($2::uuid, boundary.now + interval '1 second'),
          ($3::uuid, boundary.now),
          ($4::uuid, boundary.now - interval '1 millisecond')
        ) AS values_to_insert(request_id, expires_at)
      `,
      [accountId, future, atBoundary, expired],
    );

    const visible = (await store.listActive(accountId)).map(
      (row) => row.requestId,
    );
    expect(visible).toContain(future);
    expect(visible).not.toContain(atBoundary);
    expect(visible).not.toContain(expired);
  });
});
