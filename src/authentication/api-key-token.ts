import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ParsedApiKeyToken {
  readonly publicId: string;
  readonly secret: string;
}

export interface CreatedApiKeyToken extends ParsedApiKeyToken {
  readonly token: string;
}

export function createApiKeyToken(): CreatedApiKeyToken {
  const publicId = randomBytes(12).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  return { publicId, secret, token: `swk.${publicId}.${secret}` };
}

export function parseApiKeyToken(token: string): ParsedApiKeyToken | undefined {
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== "swk" ||
    !PUBLIC_ID_PATTERN.test(parts[1] ?? "") ||
    !SECRET_PATTERN.test(parts[2] ?? "")
  ) {
    return undefined;
  }
  return { publicId: parts[1] ?? "", secret: parts[2] ?? "" };
}

export function apiKeyDigest(key: ParsedApiKeyToken, pepper: string): Buffer {
  return createHmac("sha256", pepper)
    .update("skillwire-api-key-v1\0", "utf8")
    .update(key.publicId, "utf8")
    .update("\0", "utf8")
    .update(key.secret, "utf8")
    .digest();
}

export function apiKeyDigestsMatch(
  expected: Uint8Array,
  candidate: Uint8Array,
): boolean {
  return (
    expected.byteLength === candidate.byteLength &&
    timingSafeEqual(expected, candidate)
  );
}
