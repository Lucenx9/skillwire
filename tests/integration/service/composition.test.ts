import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createApplication,
  type Application,
} from "../../../src/composition.js";
import { PostgresApiKeyStore } from "../../../src/persistence/postgres/api-key-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

const pepper = "composition-pepper-that-is-at-least-thirty-two-bytes";

describe("composed service startup", () => {
  let database: TestDatabase;
  let application: Application;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    const accountId = randomUUID();
    await new PostgresApiKeyStore(database.pool, pepper).createAccount(
      accountId,
    );
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
          statement_timestamp() - interval '31 days',
          statement_timestamp() - interval '1 day',
          'forgotten',
          0
        )
      `,
      [accountId, randomUUID()],
    );
    application = await createApplication({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: database.connectionString,
      apiKeyPepper: pepper,
    });
  }, 120_000);

  afterAll(async () => {
    await application.close();
    await database.close();
  });

  it("runs migrations and expired-audit cleanup before readiness", async () => {
    expect(application.readiness.isReady()).toBe(true);
    const response = await application.app.request("/health/ready", {
      headers: { host: "127.0.0.1" },
    });
    expect(response.status).toBe(200);
    const expired = await database.pool.query<{ count: string }>(
      `
        SELECT count(*)
        FROM repository_erasure_audit
        WHERE expires_at <= statement_timestamp()
      `,
    );
    expect(expired.rows[0]?.count).toBe("0");
  });
});
