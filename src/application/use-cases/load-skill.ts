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
import { assertCurrentRequestActive } from "../request-execution.js";
import { sha256Hex } from "../../domain/catalog/canonical-revision.js";
import { assertRevisionIntegrity } from "../../domain/catalog/revision-integrity.js";
import type { SkillRevision } from "../../domain/catalog/types.js";

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
      assertVerifiedExactRevision(revision, input);
      const common = {
        skillId: revision.skillId,
        revision: revision.revision,
        revisionSha256: revision.bundleSha256,
        publishedProvenance: revision.publishedProvenance,
        currentAdvisoryStatus: finalStatus ?? status ?? "available",
        instructions: revision.instructions,
        resourceManifest: revision.resourceManifest,
        memoryRecorded: input.repositoryHash !== undefined,
      };
      const result: LoadSkillResult =
        revision.catalogOrigin === undefined
          ? common
          : {
              ...common,
              catalogOrigin: revision.catalogOrigin,
              currentClassification: revision.currentClassification,
              invocationMode: revision.invocationMode,
              dependencies: revision.dependencies ?? [],
            };
      assertCurrentRequestActive();
      if (input.repositoryHash !== undefined) {
        // This verified server-side usage commit cannot be atomic with later
        // transport validation or delivery; clients must not infer receipt.
        await memoryStore.recordUsage(
          repositoryMemoryScope(principal.accountId, input.repositoryHash),
          {
            skillId: result.skillId,
            revision: result.revision,
            revisionSha256: result.revisionSha256,
          },
          principal,
        );
      }
      return result;
    },
  };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function assertVerifiedExactRevision(
  revision: SkillRevision,
  input: LoadSkillInput,
): void {
  try {
    if (
      revision.skillId !== input.skillId ||
      revision.revision !== input.revision ||
      !SHA256_PATTERN.test(revision.bundleSha256) ||
      !SHA256_PATTERN.test(revision.instructionsSha256) ||
      sha256Hex(revision.instructions) !== revision.instructionsSha256
    ) {
      throw new Error("Exact revision identity or hash is invalid");
    }
    const provenance = revision.publishedProvenance;
    if (
      provenance.source.provider.length === 0 ||
      provenance.source.reference.length === 0 ||
      provenance.sourceRevision.length === 0 ||
      provenance.owner.length === 0 ||
      provenance.license.length === 0 ||
      !["trusted", "structurally-verified"].includes(
        provenance.trustAtPublication,
      )
    ) {
      throw new Error("Published provenance is invalid");
    }
    if (
      revision.resourceManifest.length !== revision.resources.length ||
      new Set(revision.resourceManifest.map(({ path }) => path)).size !==
        revision.resourceManifest.length
    ) {
      throw new Error("Resource manifest is invalid");
    }
    for (const manifest of revision.resourceManifest) {
      const resource = revision.resources.find(
        ({ path }) => path === manifest.path,
      );
      if (resource === undefined) {
        throw new Error("Verified resource is missing");
      }
      if (
        resource.mediaType !== manifest.mediaType ||
        resource.byteLength !== manifest.byteLength ||
        resource.sha256 !== manifest.sha256 ||
        Buffer.byteLength(resource.content, "utf8") !== resource.byteLength ||
        sha256Hex(resource.content) !== resource.sha256 ||
        !SHA256_PATTERN.test(resource.sha256)
      ) {
        throw new Error("Verified resource is invalid");
      }
    }
    if (provenance.trustAtPublication === "trusted") {
      assertRevisionIntegrity(revision);
      if (revision.catalogOrigin !== undefined) {
        throw new Error("First-party revision has imported metadata");
      }
    } else {
      const catalogOrigin = revision.catalogOrigin;
      if (catalogOrigin === undefined) {
        throw new Error("Imported revision origin is missing");
      }
      if (
        !GIT_SHA_PATTERN.test(catalogOrigin.commitSha) ||
        revision.currentClassification === undefined ||
        revision.invocationMode === undefined ||
        revision.dependencies === undefined
      ) {
        throw new Error("Imported revision provenance is incomplete");
      }
    }
  } catch {
    throw new SkillWireError("REVISION_UNAVAILABLE");
  }
}
