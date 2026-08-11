import type {
  RepositoryMemoryScope,
  RepositoryUsageProjection,
  SkillOutcome,
  SkillUsageRecord,
} from "../../domain/repository-memory/types.js";

export interface RecordUsageInput {
  readonly skillId: string;
  readonly revision: string;
  readonly revisionSha256: string;
}

export interface RepositoryMemoryStore {
  recordUsage(
    scope: RepositoryMemoryScope,
    input: RecordUsageInput,
  ): Promise<void>;
  list(scope: RepositoryMemoryScope): Promise<readonly SkillUsageRecord[]>;
  rankingProjection(
    scope: RepositoryMemoryScope,
  ): Promise<readonly RepositoryUsageProjection[]>;
  replaceOutcome(
    scope: RepositoryMemoryScope,
    skillId: string,
    revision: string,
    outcome: SkillOutcome,
  ): Promise<boolean>;
  forget(scope: RepositoryMemoryScope, requestId: string): Promise<void>;
}
