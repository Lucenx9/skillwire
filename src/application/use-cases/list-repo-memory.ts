import { repositoryMemoryScope } from "../../domain/repository-memory/types.js";
import type {
  RequestPrincipal,
  SkillUsageRecord,
} from "../../domain/repository-memory/types.js";
import type { RepositoryMemoryStore } from "../ports/repository-memory-store.js";

export interface ListRepoMemoryInput {
  readonly repositoryHash: string;
}

export interface ListRepoMemoryResult {
  readonly entries: readonly SkillUsageRecord[];
}

export interface ListRepoMemory {
  execute(
    input: ListRepoMemoryInput,
    principal: RequestPrincipal,
  ): Promise<ListRepoMemoryResult>;
}

export function createListRepoMemory(
  store: RepositoryMemoryStore,
): ListRepoMemory {
  return {
    async execute(input, principal) {
      const entries = await store.list(
        repositoryMemoryScope(principal.accountId, input.repositoryHash),
        principal,
      );
      return { entries };
    },
  };
}
