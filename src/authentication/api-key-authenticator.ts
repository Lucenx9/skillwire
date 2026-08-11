import type { ApiKeyStore } from "../application/ports/api-key-store.js";
import {
  apiKeyDigest,
  apiKeyDigestsMatch,
  parseApiKeyToken,
} from "./api-key-token.js";

const DUMMY_DIGEST = Buffer.alloc(32);

export interface AuthenticatedApiKey {
  readonly accountId: string;
  readonly apiKeyId: string;
}

export interface ApiKeyAuthenticator {
  authenticate(token: string): Promise<AuthenticatedApiKey | undefined>;
}

export function createApiKeyAuthenticator(
  store: ApiKeyStore,
  pepper: string,
): ApiKeyAuthenticator {
  return {
    async authenticate(token) {
      const parsed = parseApiKeyToken(token);
      if (parsed === undefined) return undefined;
      const candidate = apiKeyDigest(parsed, pepper);
      const stored = await store.findActiveByPublicId(parsed.publicId);
      const matches = apiKeyDigestsMatch(
        stored?.secretDigest ?? DUMMY_DIGEST,
        candidate,
      );
      if (!matches || stored === undefined) return undefined;
      await store.markUsed(stored.id);
      return { accountId: stored.accountId, apiKeyId: stored.id };
    },
  };
}
