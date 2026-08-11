import { canonicalJson, createSkillRevision } from "./canonical-revision.js";
import type { SkillRevision } from "./types.js";

export function assertRevisionIntegrity(
  revision: SkillRevision,
): SkillRevision {
  const reconstructed = createSkillRevision({
    skillId: revision.skillId,
    revision: revision.revision,
    publishedProvenance: revision.publishedProvenance,
    instructions: revision.instructions,
    resources: revision.resources.map((resource) => ({
      path: resource.path,
      mediaType: resource.mediaType,
      content: resource.content,
    })),
  });
  if (canonicalJson(reconstructed) !== canonicalJson(revision)) {
    throw new Error("Revision integrity verification failed");
  }
  return revision;
}
