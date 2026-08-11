import type {
  RepositoryMemoryScope,
  RepositoryUsageProjection,
  SkillOutcome,
  SkillUsageRecord,
} from "../../domain/repository-memory/types.js";
import type { RequestExecution } from "../request-execution.js";

export interface RecordUsageInput {
  readonly skillId: string;
  readonly revision: string;
  readonly revisionSha256: string;
}

export interface RepositoryMemoryStore {
  recordUsage(
    scope: RepositoryMemoryScope,
    input: RecordUsageInput,
    execution?: RequestExecution,
  ): Promise<void>;
  list(
    scope: RepositoryMemoryScope,
    execution?: RequestExecution,
  ): Promise<readonly SkillUsageRecord[]>;
  rankingProjection(
    scope: RepositoryMemoryScope,
    execution?: RequestExecution,
  ): Promise<readonly RepositoryUsageProjection[]>;
  replaceOutcome(
    scope: RepositoryMemoryScope,
    skillId: string,
    revision: string,
    outcome: SkillOutcome,
    execution?: RequestExecution,
  ): Promise<boolean>;
  forget(
    scope: RepositoryMemoryScope,
    requestId: string,
    execution?: RequestExecution,
  ): Promise<void>;
}
