import type {
  CatalogSkillMetadata,
  SkillRevision,
} from "../../domain/catalog/types.js";

export interface SkillCatalogProvider {
  listMetadata(): readonly CatalogSkillMetadata[];
  findRevision(skillId: string, revision: string): SkillRevision | undefined;
}
