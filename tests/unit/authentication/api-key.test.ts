import { describe, expect, it } from "vitest";

import {
  apiKeyDigest,
  apiKeyDigestsMatch,
  createApiKeyToken,
  parseApiKeyToken,
} from "../../../src/authentication/api-key-token.js";

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
