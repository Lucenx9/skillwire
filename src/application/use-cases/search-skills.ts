import { rankSkills } from "../../domain/catalog/ranking.js";
import type {
  CatalogSkillMetadata,
  SearchSkillsResult,
} from "../../domain/catalog/types.js";
import { repositoryMemoryScope } from "../../domain/repository-memory/types.js";
import type { RequestPrincipal } from "../../domain/repository-memory/types.js";
import type { RepositoryMemoryStore } from "../ports/repository-memory-store.js";
import type { SkillCatalogProvider } from "../ports/skill-catalog-provider.js";
import type { AsyncSkillCatalogProvider } from "../ports/async-skill-catalog-provider.js";

export interface SearchSkillsInput {
  readonly task: string;
  readonly repositoryHash?: string | undefined;
  readonly limit?: number | undefined;
  readonly invocationContext?: "automatic" | "user-requested" | undefined;
}

export interface SearchSkills {
  execute(
    input: SearchSkillsInput,
    principal: RequestPrincipal,
  ): Promise<SearchSkillsResult>;
}

export function createSearchSkills(
  catalog:
    | readonly CatalogSkillMetadata[]
    | SkillCatalogProvider
    | AsyncSkillCatalogProvider,
  memoryStore: RepositoryMemoryStore,
): SearchSkills {
  return {
    async execute(input, principal) {
      const memory =
        input.repositoryHash === undefined
          ? []
          : await memoryStore.rankingProjection(
              repositoryMemoryScope(principal.accountId, input.repositoryHash),
              principal,
            );
      const currentCatalog: readonly CatalogSkillMetadata[] = Array.isArray(
        catalog,
      )
        ? (catalog as readonly CatalogSkillMetadata[])
        : await Promise.resolve(
            (
              catalog as SkillCatalogProvider | AsyncSkillCatalogProvider
            ).listMetadata(principal),
          );
      const invocationContext = input.invocationContext ?? "automatic";
      const ranked = rankSkills(
        currentCatalog.filter(
          (skill) =>
            invocationContext === "user-requested" ||
            skill.invocationMode !== "user-only",
        ),
        input.task,
        input.limit ?? 5,
        memory,
      );
      return {
        skills: ranked.map((result, index) => {
          const common = {
            rank: index + 1,
            skillId: result.skill.id,
            name: result.skill.name,
            summary: result.skill.description,
            matchingCapabilities: result.matchingCapabilities,
            trustAtPublication: result.skill.trustAtPublication,
            currentAdvisoryStatus: result.skill.currentAdvisoryStatus,
            revision: result.skill.revision,
          };
          return result.skill.catalogOrigin === undefined
            ? common
            : {
                ...common,
                catalogOrigin: result.skill.catalogOrigin,
                currentClassification: result.skill.currentClassification,
                invocationMode: result.skill.invocationMode,
              };
        }),
      };
    },
  };
}
