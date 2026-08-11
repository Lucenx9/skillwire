export interface StoredApiKey {
  readonly id: string;
  readonly accountId: string;
  readonly secretDigest: Buffer;
}

export interface ApiKeyStore {
  findActiveByPublicId(publicId: string): Promise<StoredApiKey | undefined>;
  markUsed(keyId: string): Promise<void>;
}
