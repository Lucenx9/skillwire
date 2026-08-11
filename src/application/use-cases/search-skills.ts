import { rankSkills } from "../../domain/catalog/ranking.js";
import type {
  CatalogSkillMetadata,
  SearchSkillsResult,
} from "../../domain/catalog/types.js";
import { repositoryMemoryScope } from "../../domain/repository-memory/types.js";
import type { RequestPrincipal } from "../../domain/repository-memory/types.js";
import type { RepositoryMemoryStore } from "../ports/repository-memory-store.js";

export interface SearchSkillsInput {
  readonly task: string;
  readonly repositoryHash?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SearchSkills {
  execute(
    input: SearchSkillsInput,
    principal: RequestPrincipal,
  ): Promise<SearchSkillsResult>;
}

export function createSearchSkills(
  catalog: readonly CatalogSkillMetadata[],
  memoryStore: RepositoryMemoryStore,
): SearchSkills {
  return {
    async execute(input, principal) {
      const memory =
        input.repositoryHash === undefined
          ? []
          : await memoryStore.rankingProjection(
              repositoryMemoryScope(principal.accountId, input.repositoryHash),
            );
      const ranked = rankSkills(catalog, input.task, input.limit ?? 5, memory);
      return {
        skills: ranked.map((result, index) => ({
          rank: index + 1,
          skillId: result.skill.id,
          name: result.skill.name,
          summary: result.skill.description,
          matchingCapabilities: result.matchingCapabilities,
          trustAtPublication: result.skill.trustAtPublication,
          currentAdvisoryStatus: result.skill.currentAdvisoryStatus,
          revision: result.skill.revision,
        })),
      };
    },
  };
}
