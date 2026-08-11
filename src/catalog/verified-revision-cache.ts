import { assertRevisionIntegrity } from "../domain/catalog/revision-integrity.js";
import type { SkillRevision } from "../domain/catalog/types.js";

function cacheKey(
  releaseId: string,
  skillId: string,
  revision: string,
  bundleSha256: string,
): string {
  return `${releaseId}\0${skillId}\0${revision}\0${bundleSha256}`;
}

function verifyRevision(revision: SkillRevision): void {
  assertRevisionIntegrity(revision);
}

function immutableCopy(revision: SkillRevision): SkillRevision {
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

export class VerifiedRevisionCache {
  private readonly entries = new Map<string, SkillRevision>();

  public constructor(private readonly maximumEntries = 128) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("Cache capacity must be a positive integer");
    }
  }

  public admit(releaseId: string, revision: SkillRevision): void {
    verifyRevision(revision);
    const cachedRevision = immutableCopy(revision);
    const key = cacheKey(
      releaseId,
      revision.skillId,
      revision.revision,
      revision.bundleSha256,
    );
    if (!this.entries.has(key) && this.entries.size >= this.maximumEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, cachedRevision);
  }

  public get(
    releaseId: string,
    skillId: string,
    revision: string,
    bundleSha256: string,
  ): SkillRevision | undefined {
    const entry = this.entries.get(
      cacheKey(releaseId, skillId, revision, bundleSha256),
    );
    if (entry === undefined) return undefined;
    verifyRevision(entry);
    return entry;
  }
}
