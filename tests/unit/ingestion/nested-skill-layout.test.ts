import { describe, expect, it } from "vitest";

import { discoverNestedSkillDocuments } from "../../../src/ingestion/parsing/nested-skill-layout.js";

describe("nested SKILL.md fallback", () => {
  it("discovers bounded regular nested documents deterministically", () => {
    expect(
      discoverNestedSkillDocuments(
        [
          {
            path: "z/SKILL.md",
            mode: "100644",
            type: "blob",
            sha: "1".repeat(40),
            size: 4,
          },
          {
            path: "a/SKILL.md",
            mode: "100644",
            type: "blob",
            sha: "2".repeat(40),
            size: 4,
          },
          {
            path: "vendor/x/SKILL.md",
            mode: "100644",
            type: "blob",
            sha: "3".repeat(40),
            size: 4,
          },
          {
            path: "linked/SKILL.md",
            mode: "120000",
            type: "blob",
            sha: "4".repeat(40),
            size: 4,
          },
        ],
        { maximumCandidates: 2, excludedRoots: ["vendor"] },
      ).map(({ path }) => path),
    ).toEqual(["a/SKILL.md", "z/SKILL.md"]);
  });
});
