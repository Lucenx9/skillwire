import { repositoryMemoryScope } from "../../domain/repository-memory/types.js";
import type {
  RequestPrincipal,
  SkillOutcome,
} from "../../domain/repository-memory/types.js";
import type { RepositoryMemoryStore } from "../ports/repository-memory-store.js";

export interface RecordSkillOutcomeInput {
  readonly repositoryHash: string;
  readonly skillId: string;
  readonly revision: string;
  readonly outcome: SkillOutcome;
}

export interface RecordSkillOutcomeResult {
  readonly recorded: true;
  readonly skillId: string;
  readonly revision: string;
  readonly outcome: SkillOutcome;
}

export interface RecordSkillOutcome {
  execute(
    input: RecordSkillOutcomeInput,
    principal: RequestPrincipal,
  ): Promise<RecordSkillOutcomeResult>;
}

export function createRecordSkillOutcome(
  store: RepositoryMemoryStore,
): RecordSkillOutcome {
  return {
    async execute(input, principal) {
      const replaced = await store.replaceOutcome(
        repositoryMemoryScope(principal.accountId, input.repositoryHash),
        input.skillId,
        input.revision,
        input.outcome,
      );
      if (!replaced) throw new Error("MEMORY_CONFLICT");
      return {
        recorded: true,
        skillId: input.skillId,
        revision: input.revision,
        outcome: input.outcome,
      };
    },
  };
}
