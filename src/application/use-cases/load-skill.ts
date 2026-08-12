import type { SkillCatalogProvider } from "../ports/skill-catalog-provider.js";
import type { AsyncSkillCatalogProvider } from "../ports/async-skill-catalog-provider.js";
import { SkillWireError } from "../errors.js";
import type {
  CurrentAdvisoryStatus,
  PublishedProvenance,
  ResourceManifestEntry,
  GitHubCatalogOrigin,
  SkillDependencyReference,
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
  readonly catalogOrigin?: GitHubCatalogOrigin | undefined;
  readonly currentClassification?: "verified" | "curated" | undefined;
  readonly invocationMode?: "automatic" | "user-only" | undefined;
  readonly dependencies?: readonly SkillDependencyReference[] | undefined;
}

export interface LoadSkill {
  execute(
    input: LoadSkillInput,
    principal: RequestPrincipal,
  ): Promise<LoadSkillResult>;
}

export function createLoadSkill(
  provider: SkillCatalogProvider | AsyncSkillCatalogProvider,
  memoryStore: RepositoryMemoryStore,
): LoadSkill {
  return {
    async execute(input, principal) {
      const status = await Promise.resolve(
        provider.advisoryStatus(input.skillId, input.revision, principal),
      );
      if (status === "revoked") throw new SkillWireError("NOT_FOUND");
      let revision;
      try {
        revision = await Promise.resolve(
          provider.findRevision(input.skillId, input.revision, principal),
        );
      } catch {
        throw new SkillWireError("REVISION_UNAVAILABLE");
      }
      if (revision === undefined) {
        const latestStatus = await Promise.resolve(
          provider.advisoryStatus(input.skillId, input.revision, principal),
        );
        throw new SkillWireError(
          latestStatus === "unavailable" ? "REVISION_UNAVAILABLE" : "NOT_FOUND",
        );
      }
      const finalStatus = await Promise.resolve(
        provider.advisoryStatus(input.skillId, input.revision, principal),
      );
      if (finalStatus === "revoked") throw new SkillWireError("NOT_FOUND");
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
      const common = {
        skillId: revision.skillId,
        revision: revision.revision,
        revisionSha256: revision.bundleSha256,
        publishedProvenance: revision.publishedProvenance,
        currentAdvisoryStatus: finalStatus ?? status ?? "available",
        instructions: revision.instructions,
        resourceManifest: revision.resourceManifest,
        memoryRecorded,
      };
      return revision.catalogOrigin === undefined
        ? common
        : {
            ...common,
            catalogOrigin: revision.catalogOrigin,
            currentClassification: revision.currentClassification,
            invocationMode: revision.invocationMode,
            dependencies: revision.dependencies ?? [],
          };
    },
  };
}
