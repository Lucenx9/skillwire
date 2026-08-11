import type { SkillCatalogProvider } from "../application/ports/skill-catalog-provider.js";
import type { SkillRevision } from "../domain/catalog/types.js";
import { loadPublishedCatalog } from "./catalog-loader.js";
import { VerifiedRevisionCache } from "./verified-revision-cache.js";

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
  cache = new VerifiedRevisionCache(),
): SkillCatalogProvider {
  const loaded = loadPublishedCatalog(projectRoot, releaseId);
  const metadata = Object.freeze(
    loaded.metadata.map((entry) => Object.freeze(entry)),
  );
  const revisions = loaded.revisions.map(freezeRevision);
  revisions.forEach((revision) => {
    cache.admit(releaseId, revision);
  });
  const revisionMap = new Map(
    revisions.map((revision) => [
      `${revision.skillId}@${revision.revision}`,
      revision,
    ]),
  );
  const metadataMap = new Map(
    metadata.map((entry) => [`${entry.id}@${entry.revision}`, entry]),
  );
  return Object.freeze({
    listMetadata: () => metadata,
    findRevision: (skillId: string, revision: string) => {
      const key = `${skillId}@${revision}`;
      const status = metadataMap.get(key)?.currentAdvisoryStatus;
      const publishedRevision = revisionMap.get(key);
      if (publishedRevision === undefined || status === "revoked") {
        return undefined;
      }
      if (status === "unavailable") {
        return cache.get(
          releaseId,
          skillId,
          revision,
          publishedRevision.bundleSha256,
        );
      }
      return publishedRevision;
    },
    advisoryStatus: (skillId: string, revision: string) =>
      metadataMap.get(`${skillId}@${revision}`)?.currentAdvisoryStatus,
  });
}
