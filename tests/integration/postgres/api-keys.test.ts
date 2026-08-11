import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiKeyAuthenticator } from "../../../src/authentication/api-key-authenticator.js";
import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import { PostgresApiKeyStore } from "../../../src/persistence/postgres/api-key-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

const pepper = "integration-pepper-that-is-at-least-thirty-two-bytes";

describe("PostgreSQL accounts and bearer API keys", () => {
  let database: TestDatabase;
  let store: PostgresApiKeyStore;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    store = new PostgresApiKeyStore(database.pool, pepper);
  }, 120_000);

  afterAll(async () => database.close());

  it("maps multiple securely hashed keys to isolated accounts", async () => {
    const accountA = randomUUID();
    const accountB = randomUUID();
    await store.createAccount(accountA);
    await store.createAccount(accountB);
    const keyA1 = createApiKeyToken();
    const keyA2 = createApiKeyToken();
    const keyB = createApiKeyToken();
    await store.createKey(randomUUID(), accountA, keyA1);
    await store.createKey(randomUUID(), accountA, keyA2);
    await store.createKey(randomUUID(), accountB, keyB);
    const authenticate = createApiKeyAuthenticator(store, pepper);

    expect((await authenticate.authenticate(keyA1.token))?.accountId).toBe(
      accountA,
    );
    expect((await authenticate.authenticate(keyA2.token))?.accountId).toBe(
      accountA,
    );
    expect((await authenticate.authenticate(keyB.token))?.accountId).toBe(
      accountB,
    );

    const stored = await database.pool.query<{
      secret_digest: Buffer;
      public_id: string;
    }>("SELECT public_id, secret_digest FROM api_keys ORDER BY public_id");
    expect(stored.rows).toHaveLength(3);
    expect(
      stored.rows.every((row) => row.secret_digest.byteLength === 32),
    ).toBe(true);
    expect(JSON.stringify(stored.rows)).not.toContain(keyA1.secret);
    expect(stored.rows.map((row) => row.public_id)).toContain(keyA1.publicId);
  });

  it("observes revocation and disabled accounts without authentication caching", async () => {
    const accountId = randomUUID();
    const keyId = randomUUID();
    const key = createApiKeyToken();
    await store.createAccount(accountId);
    await store.createKey(keyId, accountId, key);
    const authenticate = createApiKeyAuthenticator(store, pepper);

    expect(await authenticate.authenticate(key.token)).toBeDefined();
    await store.revokeKey(keyId);
    expect(await authenticate.authenticate(key.token)).toBeUndefined();

    const replacementId = randomUUID();
    const replacement = createApiKeyToken();
    await store.createKey(replacementId, accountId, replacement);
    await store.disableAccount(accountId);
    expect(await authenticate.authenticate(replacement.token)).toBeUndefined();
  });
});
