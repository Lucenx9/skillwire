import type { SkillCatalogProvider } from "../ports/skill-catalog-provider.js";
import { SkillWireError } from "../errors.js";
import { sha256Hex } from "../../domain/catalog/canonical-revision.js";
import { assertSafeResourcePath } from "../../domain/catalog/resource-path.js";
import type { TextMediaType } from "../../domain/catalog/types.js";

export interface ReadSkillResourceInput {
  readonly skillId: string;
  readonly revision: string;
  readonly path: string;
}

export interface ReadSkillResourceResult {
  readonly skillId: string;
  readonly revision: string;
  readonly revisionSha256: string;
  readonly path: string;
  readonly mediaType: TextMediaType;
  readonly byteLength: number;
  readonly sha256: string;
  readonly content: string;
}

export interface ReadSkillResource {
  execute(input: ReadSkillResourceInput): ReadSkillResourceResult;
}

export function createReadSkillResource(
  provider: SkillCatalogProvider,
): ReadSkillResource {
  return {
    execute(input) {
      try {
        assertSafeResourcePath(input.path);
      } catch {
        throw new SkillWireError("RESOURCE_REJECTED");
      }
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
      const resource = revision.resources.find(
        (entry) => entry.path === input.path,
      );
      if (resource === undefined) throw new SkillWireError("NOT_FOUND");
      if (
        Buffer.byteLength(resource.content, "utf8") !== resource.byteLength ||
        sha256Hex(resource.content) !== resource.sha256
      ) {
        throw new SkillWireError("RESOURCE_REJECTED");
      }
      return {
        skillId: revision.skillId,
        revision: revision.revision,
        revisionSha256: revision.bundleSha256,
        path: resource.path,
        mediaType: resource.mediaType,
        byteLength: resource.byteLength,
        sha256: resource.sha256,
        content: resource.content,
      };
    },
  };
}
