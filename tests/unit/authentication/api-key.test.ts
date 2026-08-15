import { describe, expect, it } from "vitest";

import {
  apiKeyDigest,
  apiKeyDigestsMatch,
  createApiKeyToken,
  parseApiKeyToken,
} from "../../../src/authentication/api-key-token.js";
import {
  AccountApiKeyRateLimiter,
  AuthenticationRateLimiter,
} from "../../../src/authentication/middleware.js";
import type { RequestPrincipal } from "../../../src/domain/repository-memory/types.js";

const pepper = "test-pepper-that-is-at-least-thirty-two-bytes";

describe("bearer API-key primitives", () => {
  it("creates a parseable token with separate public and secret parts", () => {
    const created = createApiKeyToken();

    expect(parseApiKeyToken(created.token)).toEqual({
      publicId: created.publicId,
      secret: created.secret,
    });
    expect(created.secret.length).toBeGreaterThanOrEqual(43);
  });

  it.each([
    "",
    "Bearer token",
    "swk.missing",
    "swk.invalid public.secret",
    "swk.aaaaaaaaaaaaaaaa.short",
  ])("rejects malformed tokens without normalization: %s", (token) => {
    expect(parseApiKeyToken(token)).toBeUndefined();
  });

  it("uses a deterministic non-recoverable keyed digest and constant-time comparison", () => {
    const token = createApiKeyToken();
    const digest = apiKeyDigest(token, pepper);
    const other = apiKeyDigest(createApiKeyToken(), pepper);

    expect(digest).toHaveLength(32);
    expect(Buffer.from(digest).toString("utf8")).not.toContain(token.secret);
    expect(apiKeyDigestsMatch(digest, Buffer.from(digest))).toBe(true);
    expect(apiKeyDigestsMatch(digest, other)).toBe(false);
    expect(apiKeyDigestsMatch(digest, Buffer.alloc(31))).toBe(false);
  });
});

describe("account and API-key rate policy", () => {
  const principal = (
    accountId: string,
    apiKeyId: string,
  ): RequestPrincipal => ({
    accountId,
    apiKeyId,
    requestId: "00000000-0000-4000-8000-000000000001",
  });

  it("enforces the shared account bucket across multiple keys", () => {
    const limiter = new AccountApiKeyRateLimiter({
      accountRequestsPerMinute: 60,
      apiKeyRequestsPerMinute: 600,
      burst: 2,
    });

    expect(limiter.consume(principal("account-a", "key-a")).allowed).toBe(true);
    expect(limiter.consume(principal("account-a", "key-b")).allowed).toBe(true);
    expect(limiter.consume(principal("account-a", "key-c"))).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(limiter.consume(principal("account-b", "key-d")).allowed).toBe(true);
  });

  it("enforces and refills each API-key bucket independently", () => {
    let now = 0;
    const limiter = new AccountApiKeyRateLimiter(
      {
        accountRequestsPerMinute: 600,
        apiKeyRequestsPerMinute: 60,
        burst: 1,
      },
      () => now,
    );

    expect(limiter.consume(principal("account-a", "key-a")).allowed).toBe(true);
    expect(limiter.consume(principal("account-a", "key-a")).allowed).toBe(
      false,
    );
    expect(limiter.consume(principal("account-b", "key-b")).allowed).toBe(true);
    now = 1000;
    expect(limiter.consume(principal("account-a", "key-a")).allowed).toBe(true);
  });
});

describe("authentication rate policy", () => {
  it("caps and refills database-bound attempts per public id", () => {
    let now = 0;
    const limiter = new AuthenticationRateLimiter(
      {
        accountRequestsPerMinute: 600,
        apiKeyRequestsPerMinute: 600,
        burst: 10,
        authenticationRequestsPerMinute: 60,
        authenticationBurst: 2,
      },
      () => now,
    );

    expect(limiter.consume("public-a").allowed).toBe(true);
    expect(limiter.consume("public-a").allowed).toBe(true);
    expect(limiter.consume("public-a")).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(limiter.consume("public-b").allowed).toBe(true);
    now = 1000;
    expect(limiter.consume("public-a").allowed).toBe(true);
  });
});
