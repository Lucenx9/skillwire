import type { RequestExecution } from "../request-execution.js";

export interface StoredApiKey {
  readonly id: string;
  readonly accountId: string;
  readonly secretDigest: Buffer;
}

export interface ApiKeyStore {
  findActiveByPublicId(
    publicId: string,
    execution?: RequestExecution,
  ): Promise<StoredApiKey | undefined>;
  markUsed(keyId: string, execution?: RequestExecution): Promise<void>;
}
