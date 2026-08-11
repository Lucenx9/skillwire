const REPOSITORY_HASH_PATTERN = /^[0-9a-f]{64}$/;

export type RepositoryHash = string;

export interface RepositoryMemoryScope {
  readonly accountId: string;
  readonly repositoryHash: RepositoryHash;
}

export interface RequestPrincipal {
  readonly accountId: string;
  readonly apiKeyId: string;
  readonly requestId: string;
}

export type SkillOutcome = "useful" | "neutral" | "unsuccessful";

export interface SkillUsageRecord {
  readonly skillId: string;
  readonly revision: string;
  readonly revisionSha256: string;
  readonly firstUsedAt: string;
  readonly lastUsedAt: string;
  readonly usageCount: number;
  readonly outcome?: SkillOutcome | undefined;
}

export interface RepositoryUsageProjection {
  readonly skillId: string;
  readonly revision: string;
  readonly outcome: SkillOutcome | null;
}

export function assertRepositoryHash(value: string): RepositoryHash {
  if (!REPOSITORY_HASH_PATTERN.test(value)) {
    throw new Error(
      "Repository hash must be exactly 64 lowercase hexadecimal characters",
    );
  }
  return value;
}

export function repositoryMemoryScope(
  accountId: string,
  repositoryHash: string,
): RepositoryMemoryScope {
  if (accountId.length === 0) throw new Error("Account ID is required");
  return { accountId, repositoryHash: assertRepositoryHash(repositoryHash) };
}
