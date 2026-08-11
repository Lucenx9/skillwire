import { describe, expect, it } from "vitest";

import { createExternalSkillRevision } from "../../../src/domain/external-catalog/canonical-revision-v2.js";

const input = {
  skillId: "gh-123-grill-with-docs-a1b2c3d4",
  provenance: {
    provider: "github" as const,
    repositoryId: 123,
    owner: "mattpocock",
    repository: "skills",
    commitSha: "84fdeffd12f2ee307994d1eb6feb48173b6e0502",
    skillPath: "skills/engineering/grill-with-docs/SKILL.md",
    sourceOwner: "Matt Pocock",
    spdxLicenseId: "MIT",
    licenseText: "MIT License\n",
  },
  skill: {
    name: "grill-with-docs",
    description: "Interview",
    skillPath: "skills/engineering/grill-with-docs/SKILL.md",
    instructions: "Run /grilling with /domain-modeling.\n",
    invocationMode: "user-only" as const,
    resources: [],
    dependencies: [
      {
        skillName: "grilling",
        required: true,
        evidenceKind: "explicit-invocation" as const,
        evidenceLocator: "instructions:1",
      },
    ],
  },
};

describe("external canonical revision v2", () => {
  it("is deterministic and binds provenance, dependencies, and content", () => {
    const first = createExternalSkillRevision(input);
    const second = createExternalSkillRevision(input);
    expect(first).toEqual(second);
    expect(first.revision).toBe(`gh-${first.bundleSha256}`);
    expect(first.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.contentIdentitySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.canonicalBytes).toContain(input.provenance.commitSha);
  });

  it("reuses content identity across observation commits but changes bundle identity", () => {
    const original = createExternalSkillRevision(input);
    const later = createExternalSkillRevision({
      ...input,
      provenance: {
        ...input.provenance,
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    expect(later.contentIdentitySha256).toBe(original.contentIdentitySha256);
    expect(later.bundleSha256).not.toBe(original.bundleSha256);
  });
});
