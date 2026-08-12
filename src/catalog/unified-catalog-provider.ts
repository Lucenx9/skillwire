import type { AsyncSkillCatalogProvider } from "../application/ports/async-skill-catalog-provider.js";
import type { RequestExecution } from "../application/request-execution.js";
import type {
  CatalogSkillMetadata,
  CurrentAdvisoryStatus,
  SkillRevision,
} from "../domain/catalog/types.js";

function originPriority(skill: CatalogSkillMetadata | SkillRevision): number {
  return skill.catalogOrigin === undefined ? 0 : 1;
}

export class UnifiedCatalogProvider implements AsyncSkillCatalogProvider {
  constructor(
    private readonly providers: readonly AsyncSkillCatalogProvider[],
  ) {}

  async listMetadata(
    execution: RequestExecution = {},
  ): Promise<readonly CatalogSkillMetadata[]> {
    const values = (
      await Promise.all(
        this.providers.map((provider) => provider.listMetadata(execution)),
      )
    ).flat();
    const selected = new Map<string, CatalogSkillMetadata>();
    for (const skill of values.toSorted((left, right) => {
      const key = `${left.id}\0${left.revision}`.localeCompare(
        `${right.id}\0${right.revision}`,
        "en-US",
      );
      return key === 0 ? originPriority(left) - originPriority(right) : key;
    })) {
      const selectedKey = `${skill.id}\0${skill.revision}`;
      if (!selected.has(selectedKey)) selected.set(selectedKey, skill);
    }
    return [...selected.values()].toSorted((left, right) =>
      `${left.id}\0${left.revision}`.localeCompare(
        `${right.id}\0${right.revision}`,
        "en-US",
      ),
    );
  }

  async findRevision(
    skillId: string,
    revision: string,
    execution: RequestExecution = {},
  ): Promise<SkillRevision | undefined> {
    for (const provider of this.providers) {
      const found = await provider.findRevision(skillId, revision, execution);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  async advisoryStatus(
    skillId: string,
    revision: string,
    execution: RequestExecution = {},
  ): Promise<CurrentAdvisoryStatus | undefined> {
    for (const provider of this.providers) {
      const status = await provider.advisoryStatus(
        skillId,
        revision,
        execution,
      );
      if (status !== undefined) return status;
    }
    return undefined;
  }
}
