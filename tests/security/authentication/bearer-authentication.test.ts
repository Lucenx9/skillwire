import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiKeyAuthenticator } from "../../../src/authentication/api-key-authenticator.js";
import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import { PostgresApiKeyStore } from "../../../src/persistence/postgres/api-key-store.js";
import { createTestApplication } from "../../../src/composition.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

const pepper = "security-pepper-that-is-at-least-thirty-two-bytes";
const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "security-test", version: "1.0.0" },
  },
});

describe("database-backed bearer authentication", () => {
  let database: TestDatabase;
  let app: ReturnType<typeof createTestApplication>["app"];
  let validToken: string;
  const invalidTokens: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    const store = new PostgresApiKeyStore(database.pool, pepper);
    const activeAccount = randomUUID();
    await store.createAccount(activeAccount);
    const valid = createApiKeyToken();
    validToken = valid.token;
    await store.createKey(randomUUID(), activeAccount, valid);

    const revoked = createApiKeyToken();
    const revokedId = randomUUID();
    await store.createKey(revokedId, activeAccount, revoked);
    await store.revokeKey(revokedId);
    invalidTokens.push(revoked.token);

    const expired = createApiKeyToken();
    const expiredId = randomUUID();
    await store.createKey(expiredId, activeAccount, expired);
    await database.pool.query(
      `
        UPDATE api_keys
        SET
          created_at = statement_timestamp() - interval '2 days',
          expires_at = statement_timestamp() - interval '1 day'
        WHERE id = $1
      `,
      [expiredId],
    );
    invalidTokens.push(expired.token);

    const disabledAccount = randomUUID();
    await store.createAccount(disabledAccount);
    const disabled = createApiKeyToken();
    await store.createKey(randomUUID(), disabledAccount, disabled);
    await store.disableAccount(disabledAccount);
    invalidTokens.push(disabled.token, createApiKeyToken().token, "malformed");

    app = createTestApplication({
      authenticator: createApiKeyAuthenticator(store, pepper),
    }).app;
  }, 120_000);

  afterAll(async () => database.close());

  async function request(token?: string) {
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "127.0.0.1",
    });
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    return app.request("/mcp", {
      method: "POST",
      headers,
      body: initializeBody,
    });
  }

  it("accepts an active key", async () => {
    expect((await request(validToken)).status).toBe(200);
  });

  it("gives missing, malformed, unknown, expired, revoked, and disabled keys one shape", async () => {
    const responses = await Promise.all([
      request(),
      ...invalidTokens.map((token) => request(token)),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      const body = (await response.json()) as unknown;
      expect(body).toMatchObject({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required.",
          retryable: false,
        },
      });
      expect(JSON.stringify(body)).toMatch(
        /"requestId":"[0-9a-f]{8}-[0-9a-f-]{27}"/,
      );
    }
  });
});

describe("pre-authentication rate limiting", () => {
  it("rejects excess bearer attempts before invoking the authenticator", async () => {
    let calls = 0;
    const app = createTestApplication({
      authenticator: {
        authenticate: () => {
          calls += 1;
          return Promise.resolve(undefined);
        },
      },
      rateLimit: {
        accountRequestsPerMinute: 60_000,
        apiKeyRequestsPerMinute: 60_000,
        burst: 1000,
        authenticationRequestsPerMinute: 1,
        authenticationBurst: 1,
      },
    }).app;
    const token = createApiKeyToken().token;
    const request = () =>
      app.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          host: "127.0.0.1",
        },
        body: initializeBody,
      });

    expect((await request()).status).toBe(401);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(calls).toBe(1);
  });

  it("does not let unknown public ids exhaust another key's limit", async () => {
    let calls = 0;
    const app = createTestApplication({
      authenticator: {
        authenticate: () => {
          calls += 1;
          return Promise.resolve(undefined);
        },
      },
      rateLimit: {
        accountRequestsPerMinute: 60_000,
        apiKeyRequestsPerMinute: 60_000,
        burst: 1000,
        authenticationRequestsPerMinute: 1,
        authenticationBurst: 1,
      },
    }).app;
    const request = (token: string) =>
      app.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          host: "127.0.0.1",
        },
        body: initializeBody,
      });

    expect((await request(createApiKeyToken().token)).status).toBe(401);
    expect((await request(createApiKeyToken().token)).status).toBe(401);
    expect(calls).toBe(2);
  });
});
