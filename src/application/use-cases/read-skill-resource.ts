import type { SkillCatalogProvider } from "../ports/skill-catalog-provider.js";
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
      assertSafeResourcePath(input.path);
      const revision = provider.findRevision(input.skillId, input.revision);
      if (revision === undefined)
        throw new Error("Exact skill revision was not found");
      const resource = revision.resources.find(
        (entry) => entry.path === input.path,
      );
      if (resource === undefined)
        throw new Error("Declared skill resource was not found");
      if (
        Buffer.byteLength(resource.content, "utf8") !== resource.byteLength ||
        sha256Hex(resource.content) !== resource.sha256
      ) {
        throw new Error("Verified resource integrity check failed");
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
