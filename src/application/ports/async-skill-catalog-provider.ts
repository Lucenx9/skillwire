import type {
  CatalogSkillMetadata,
  CurrentAdvisoryStatus,
  SkillRevision,
} from "../../domain/catalog/types.js";
import type { RequestExecution } from "../request-execution.js";

export interface AsyncSkillCatalogProvider {
  listMetadata(
    execution?: RequestExecution,
  ): Promise<readonly CatalogSkillMetadata[]>;
  findRevision(
    skillId: string,
    revision: string,
    execution?: RequestExecution,
  ): Promise<SkillRevision | undefined>;
  advisoryStatus(
    skillId: string,
    revision: string,
    execution?: RequestExecution,
  ): Promise<CurrentAdvisoryStatus | undefined>;
}
