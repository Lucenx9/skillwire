import type { SkillCatalogProvider } from "../ports/skill-catalog-provider.js";
import { SkillWireError } from "../errors.js";
import type {
  CurrentAdvisoryStatus,
  PublishedProvenance,
  ResourceManifestEntry,
} from "../../domain/catalog/types.js";
import { repositoryMemoryScope } from "../../domain/repository-memory/types.js";
import type { RequestPrincipal } from "../../domain/repository-memory/types.js";
import type { RepositoryMemoryStore } from "../ports/repository-memory-store.js";

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
  readonly memoryRecorded: boolean;
}

export interface LoadSkill {
  execute(
    input: LoadSkillInput,
    principal: RequestPrincipal,
  ): Promise<LoadSkillResult>;
}

export function createLoadSkill(
  provider: SkillCatalogProvider,
  memoryStore: RepositoryMemoryStore,
): LoadSkill {
  return {
    async execute(input, principal) {
      const status = provider.advisoryStatus(input.skillId, input.revision);
      if (status === "revoked") throw new SkillWireError("NOT_FOUND");
      let revision;
      try {
        revision = provider.findRevision(input.skillId, input.revision);
      } catch {
        throw new SkillWireError("REVISION_UNAVAILABLE");
      }
      if (revision === undefined) {
        throw new SkillWireError(
          status === "unavailable" ? "REVISION_UNAVAILABLE" : "NOT_FOUND",
        );
      }
      const memoryRecorded = input.repositoryHash !== undefined;
      if (input.repositoryHash !== undefined) {
        await memoryStore.recordUsage(
          repositoryMemoryScope(principal.accountId, input.repositoryHash),
          {
            skillId: revision.skillId,
            revision: revision.revision,
            revisionSha256: revision.bundleSha256,
          },
          principal,
        );
      }
      return {
        skillId: revision.skillId,
        revision: revision.revision,
        revisionSha256: revision.bundleSha256,
        publishedProvenance: revision.publishedProvenance,
        currentAdvisoryStatus: status ?? "available",
        instructions: revision.instructions,
        resourceManifest: revision.resourceManifest,
        memoryRecorded,
      };
    },
  };
}
