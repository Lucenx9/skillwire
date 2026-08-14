import type { AsyncSkillCatalogProvider } from "../application/ports/async-skill-catalog-provider.js";
import { assertRequestActive } from "../application/request-execution.js";
import type { SkillCatalogProvider } from "../application/ports/skill-catalog-provider.js";

export function adaptStaticCatalogProvider(
  provider: SkillCatalogProvider,
): AsyncSkillCatalogProvider {
  return {
    listMetadata(execution = {}) {
      assertRequestActive(execution);
      return Promise.resolve(provider.listMetadata());
    },
    findRevision(skillId, revision, execution = {}) {
      assertRequestActive(execution);
      return Promise.resolve(provider.findRevision(skillId, revision));
    },
    advisoryStatus(skillId, revision, execution = {}) {
      assertRequestActive(execution);
      return Promise.resolve(provider.advisoryStatus(skillId, revision));
    },
  };
}
