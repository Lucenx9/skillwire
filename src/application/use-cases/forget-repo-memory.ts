import { repositoryMemoryScope } from "../../domain/repository-memory/types.js";
import type { RequestPrincipal } from "../../domain/repository-memory/types.js";
import type { RepositoryMemoryStore } from "../ports/repository-memory-store.js";
import { SkillWireError } from "../errors.js";

export interface ForgetRepoMemoryInput {
  readonly repositoryHash: string;
}

export interface ForgetRepoMemoryResult {
  readonly forgotten: true;
}

export interface ForgetRepoMemory {
  execute(
    input: ForgetRepoMemoryInput,
    principal: RequestPrincipal,
  ): Promise<ForgetRepoMemoryResult>;
}

export function createForgetRepoMemory(
  store: RepositoryMemoryStore,
): ForgetRepoMemory {
  return {
    async execute(input, principal) {
      try {
        await store.forget(
          repositoryMemoryScope(principal.accountId, input.repositoryHash),
          principal.requestId,
          principal,
        );
      } catch {
        throw new SkillWireError("ERASURE_INCOMPLETE");
      }
      return { forgotten: true };
    },
  };
}
