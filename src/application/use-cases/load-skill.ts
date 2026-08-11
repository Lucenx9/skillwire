import type { SkillCatalogProvider } from "../ports/skill-catalog-provider.js";
import type {
  CurrentAdvisoryStatus,
  PublishedProvenance,
  ResourceManifestEntry,
} from "../../domain/catalog/types.js";

export interface LoadSkillInput {
  readonly skillId: string;
  readonly revision: string;
  readonly repositoryHash?: string | undefined;
}

export interface LoadSkillResult {
  readonly skillId: string;
  readonly revision: string;
  readonly revisionSha256: string;
  readonly publishedProvenance: PublishedProvenance;
  readonly currentAdvisoryStatus: CurrentAdvisoryStatus;
  readonly instructions: string;
  readonly resourceManifest: readonly ResourceManifestEntry[];
  readonly memoryRecorded: false;
}

export interface LoadSkill {
  execute(input: LoadSkillInput): LoadSkillResult;
}

export function createLoadSkill(provider: SkillCatalogProvider): LoadSkill {
  return {
    execute(input) {
      const revision = provider.findRevision(input.skillId, input.revision);
      if (revision === undefined)
        throw new Error("Exact skill revision was not found");
      return {
        skillId: revision.skillId,
        revision: revision.revision,
        revisionSha256: revision.bundleSha256,
        publishedProvenance: revision.publishedProvenance,
        currentAdvisoryStatus: "available",
        instructions: revision.instructions,
        resourceManifest: revision.resourceManifest,
        memoryRecorded: false,
      };
    },
  };
}
