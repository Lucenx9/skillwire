import type { SkillCatalogProvider } from "../application/ports/skill-catalog-provider.js";
import type { SkillRevision } from "../domain/catalog/types.js";
import { loadPublishedCatalog } from "./catalog-loader.js";

function freezeRevision(revision: SkillRevision): SkillRevision {
  return Object.freeze({
    ...revision,
    publishedProvenance: Object.freeze({
      ...revision.publishedProvenance,
      source: Object.freeze({ ...revision.publishedProvenance.source }),
    }),
    resourceManifest: Object.freeze(
      revision.resourceManifest.map((entry) => Object.freeze({ ...entry })),
    ),
    resources: Object.freeze(
      revision.resources.map((entry) => Object.freeze({ ...entry })),
    ),
  });
}

export function loadVerifiedCatalogProvider(
  projectRoot: string,
  releaseId: string,
): SkillCatalogProvider {
  const loaded = loadPublishedCatalog(projectRoot, releaseId);
  const metadata = Object.freeze(
    loaded.inventory.map((entry) => Object.freeze(entry)),
  );
  const revisions = loaded.revisions.map(freezeRevision);
  const revisionMap = new Map(
    revisions.map((revision) => [
      `${revision.skillId}@${revision.revision}`,
      revision,
    ]),
  );
  return Object.freeze({
    listMetadata: () => metadata,
    findRevision: (skillId: string, revision: string) =>
      revisionMap.get(`${skillId}@${revision}`),
  });
}
