import type { ApiKeyStore } from "../application/ports/api-key-store.js";
import {
  assertRequestActive,
  type RequestExecution,
} from "../application/request-execution.js";
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
  authenticate(
    token: string,
    execution?: RequestExecution,
  ): Promise<AuthenticatedApiKey | undefined>;
}

export function createApiKeyAuthenticator(
  store: ApiKeyStore,
  pepper: string,
): ApiKeyAuthenticator {
  return {
    async authenticate(token, execution = {}) {
      assertRequestActive(execution);
      const parsed = parseApiKeyToken(token);
      if (parsed === undefined) return undefined;
      const candidate = apiKeyDigest(parsed, pepper);
      const stored = await store.findActiveByPublicId(
        parsed.publicId,
        execution,
      );
      assertRequestActive(execution);
      const matches = apiKeyDigestsMatch(
        stored?.secretDigest ?? DUMMY_DIGEST,
        candidate,
      );
      if (!matches || stored === undefined) return undefined;
      await store.markUsed(stored.id, execution);
      assertRequestActive(execution);
      return { accountId: stored.accountId, apiKeyId: stored.id };
    },
  };
}
