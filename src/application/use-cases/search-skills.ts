import { rankSkills } from "../../domain/catalog/ranking.js";
import type {
  CatalogSkillMetadata,
  SearchSkillsResult,
} from "../../domain/catalog/types.js";

export interface SearchSkillsInput {
  readonly task: string;
  readonly repositoryHash?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SearchSkills {
  execute(input: SearchSkillsInput): SearchSkillsResult;
}

export function createSearchSkills(
  catalog: readonly CatalogSkillMetadata[],
): SearchSkills {
  return {
    execute(input) {
      const ranked = rankSkills(catalog, input.task, input.limit ?? 5);
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
