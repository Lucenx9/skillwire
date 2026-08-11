import type {
  RecordUsageInput,
  RepositoryMemoryStore,
} from "../../src/application/ports/repository-memory-store.js";
import type {
  RepositoryMemoryScope,
  RepositoryUsageProjection,
  SkillOutcome,
  SkillUsageRecord,
} from "../../src/domain/repository-memory/types.js";

interface StoredEntry extends SkillUsageRecord {
  readonly accountId: string;
  readonly repositoryHash: string;
}

const TEST_TIME = "2026-08-11T12:00:00.000Z";

function entryKey(
  scope: RepositoryMemoryScope,
  skillId: string,
  revision: string,
): string {
  return `${scope.accountId}:${scope.repositoryHash}:${skillId}:${revision}`;
}

export class FakeRepositoryMemoryStore implements RepositoryMemoryStore {
  private readonly entries = new Map<string, StoredEntry>();

  public recordUsage(
    scope: RepositoryMemoryScope,
    input: RecordUsageInput,
  ): Promise<void> {
    const key = entryKey(scope, input.skillId, input.revision);
    const existing = this.entries.get(key);
    this.entries.set(key, {
      accountId: scope.accountId,
      repositoryHash: scope.repositoryHash,
      skillId: input.skillId,
      revision: input.revision,
      revisionSha256: input.revisionSha256,
      firstUsedAt: existing?.firstUsedAt ?? TEST_TIME,
      lastUsedAt: TEST_TIME,
      usageCount: (existing?.usageCount ?? 0) + 1,
      ...(existing?.outcome === undefined ? {} : { outcome: existing.outcome }),
    });
    return Promise.resolve();
  }

  public list(
    scope: RepositoryMemoryScope,
  ): Promise<readonly SkillUsageRecord[]> {
    return Promise.resolve(
      [...this.entries.values()]
        .filter(
          (entry) =>
            entry.accountId === scope.accountId &&
            entry.repositoryHash === scope.repositoryHash,
        )
        .map(
          ({
            accountId: _accountId,
            repositoryHash: _repositoryHash,
            ...entry
          }) => entry,
        ),
    );
  }

  public async rankingProjection(
    scope: RepositoryMemoryScope,
  ): Promise<readonly RepositoryUsageProjection[]> {
    return (await this.list(scope)).map((entry) => ({
      skillId: entry.skillId,
      revision: entry.revision,
      outcome: entry.outcome ?? null,
    }));
  }

  public replaceOutcome(
    scope: RepositoryMemoryScope,
    skillId: string,
    revision: string,
    outcome: SkillOutcome,
  ): Promise<boolean> {
    const key = entryKey(scope, skillId, revision);
    const existing = this.entries.get(key);
    if (existing === undefined) return Promise.resolve(false);
    this.entries.set(key, { ...existing, outcome });
    return Promise.resolve(true);
  }

  public forget(
    scope: RepositoryMemoryScope,
    _requestId: string,
  ): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (
        entry.accountId === scope.accountId &&
        entry.repositoryHash === scope.repositoryHash
      ) {
        this.entries.delete(key);
      }
    }
    return Promise.resolve();
  }
}
