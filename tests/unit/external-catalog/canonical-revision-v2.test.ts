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

  it("immutably binds license and NOTICE paths, Git blob identities, and content hashes", () => {
    const revision = createExternalSkillRevision({
      ...input,
      provenance: {
        ...input.provenance,
        licenseEvidencePath: "LICENSE",
        licenseBlobSha: "1".repeat(40),
        skillDeclaredSpdxId: "MIT",
        noticeText: "Copyright 2026 Matt Pocock\n",
        noticeEvidencePath: "NOTICE",
        noticeBlobSha: "2".repeat(40),
      },
    });
    const canonical = JSON.parse(revision.canonicalBytes) as {
      source: Record<string, string>;
      noticeText: string;
    };
    expect(canonical.source).toMatchObject({
      licenseEvidencePath: "LICENSE",
      licenseBlobSha: "1".repeat(40),
      skillDeclaredSpdxId: "MIT",
      noticeEvidencePath: "NOTICE",
      noticeBlobSha: "2".repeat(40),
      noticeSha256: canonical.source["noticeSha256"],
    });
    expect(canonical.source["noticeSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(canonical.noticeText).toBe("Copyright 2026 Matt Pocock\n");
    expect(
      createExternalSkillRevision({
        ...input,
        provenance: {
          ...input.provenance,
          licenseEvidencePath: "LICENSE",
          licenseBlobSha: "1".repeat(40),
          skillDeclaredSpdxId: "MIT",
          noticeText: "Changed notice\n",
          noticeEvidencePath: "NOTICE",
          noticeBlobSha: "3".repeat(40),
        },
      }).bundleSha256,
    ).not.toBe(revision.bundleSha256);
  });
});
