import type {
  CatalogSkillMetadata,
  CurrentAdvisoryStatus,
  SkillRevision,
} from "../../domain/catalog/types.js";

export interface SkillCatalogProvider {
  listMetadata(): readonly CatalogSkillMetadata[];
  findRevision(skillId: string, revision: string): SkillRevision | undefined;
  advisoryStatus(
    skillId: string,
    revision: string,
  ): CurrentAdvisoryStatus | undefined;
}
