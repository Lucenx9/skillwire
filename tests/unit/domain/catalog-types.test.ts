import { describe, expect, it } from "vitest";

import type {
  CatalogRelease,
  CatalogSkill,
  PublishedProvenance,
  ResourceManifestEntry,
  RevisionAdvisory,
  SearchPreview,
} from "../../../src/domain/catalog/types.js";
import { createSkillRevision } from "../../../src/domain/catalog/canonical-revision.js";
import { assertRevisionIntegrity } from "../../../src/domain/catalog/revision-integrity.js";

describe("catalog domain types", () => {
  it("constructs the catalog, provenance, revision, preview, advisory, and release values", () => {
    const catalogSkill: CatalogSkill = {
      id: "example-skill",
      name: "Example Skill",
      description: "Example description",
      capabilities: ["example"],
      revisions: ["1.0.0"],
    };
    const provenance: PublishedProvenance = {
      source: { provider: "git", reference: "skillwire/example" },
      sourceRevision: "1.0.0",
      owner: "SkillWire maintainers",
      license: "Apache-2.0",
      trustAtPublication: "trusted",
    };
    const revision = createSkillRevision({
      skillId: catalogSkill.id,
      revision: catalogSkill.revisions[0] ?? "",
      publishedProvenance: provenance,
      instructions: "# Example\n",
      resources: [
        {
          path: "references/example.md",
          mediaType: "text/markdown",
          content: "example\n",
        },
      ],
    });
    const manifest: ResourceManifestEntry = revision.resourceManifest[0] ?? {
      path: "",
      mediaType: "text/plain",
      byteLength: 0,
      sha256: "",
    };
    const preview: SearchPreview = {
      rank: 1,
      skillId: catalogSkill.id,
      name: catalogSkill.name,
      summary: catalogSkill.description,
      matchingCapabilities: catalogSkill.capabilities,
      trustAtPublication: "trusted",
      currentAdvisoryStatus: "available",
      revision: revision.revision,
    };
    const advisory: RevisionAdvisory = {
      sequence: 1,
      previousEventHash: "0".repeat(64),
      advisoryId: "example-available",
      skillId: revision.skillId,
      revision: revision.revision,
      revisionSha256: revision.bundleSha256,
      kind: "availability",
      state: "available",
      reasonCode: "PUBLISHED",
      effectiveAt: "2026-08-11T00:00:00.000Z",
      eventHash: "1".repeat(64),
    };
    const release: CatalogRelease = {
      schemaVersion: 1,
      releaseId: "example-release",
      genesis: true,
      previousReleaseCommit: null,
      inventorySha256: "2".repeat(64),
      advisoryChainHead: advisory.eventHash,
      revisionCount: 10,
      revisions: [
        {
          skillId: revision.skillId,
          revision: revision.revision,
          bundleSha256: revision.bundleSha256,
          recordPath: "revisions/example-skill.json",
        },
      ],
      publishedAt: "2026-08-11T00:00:00.000Z",
    };

    expect(assertRevisionIntegrity(revision)).toBe(revision);
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.trustAtPublication).toBe("trusted");
    expect(advisory.previousEventHash).toHaveLength(64);
    expect(release.genesis).toBe(true);
  });

  it("rejects a mutated revision integrity binding", () => {
    const revision = createSkillRevision({
      skillId: "example-skill",
      revision: "1.0.0",
      publishedProvenance: {
        source: { provider: "git", reference: "skillwire/example" },
        sourceRevision: "1.0.0",
        owner: "SkillWire maintainers",
        license: "Apache-2.0",
        trustAtPublication: "trusted",
      },
      instructions: "# Example\n",
      resources: [
        {
          path: "references/example.md",
          mediaType: "text/markdown",
          content: "example\n",
        },
      ],
    });

    expect(() =>
      assertRevisionIntegrity({ ...revision, instructions: "# Mutated\n" }),
    ).toThrow();
  });
});
