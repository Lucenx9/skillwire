import type {
  ExternalCatalogStore,
  PublishExternalSnapshotInput,
  PublishedExternalSnapshot,
} from "../application/ports/external-catalog-store.js";
import type { OperationContext } from "../application/ports/github-source-provider.js";
import { assertExternalRevisionIntegrity } from "../domain/external-catalog/canonical-revision-v2.js";

export class ExternalRevisionPublisher {
  constructor(private readonly store: ExternalCatalogStore) {}

  publish(
    input: PublishExternalSnapshotInput,
    context?: OperationContext,
  ): Promise<PublishedExternalSnapshot> {
    const skillIds = new Set<string>();
    for (const revision of input.revisions) {
      assertExternalRevisionIntegrity(revision);
      if (skillIds.has(revision.skillId))
        throw new Error("DUPLICATE_SKILL_IDENTITY");
      skillIds.add(revision.skillId);
      if (revision.provenance.commitSha !== input.commitSha) {
        throw new Error("COMMIT_MISMATCH");
      }
    }
    return this.store.publishSnapshot(input, context);
  }
}
