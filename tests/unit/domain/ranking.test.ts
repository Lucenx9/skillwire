import { describe, expect, it } from "vitest";

import type { CatalogSkillMetadata } from "../../../src/domain/catalog/types.js";
import { rankSkills } from "../../../src/domain/catalog/ranking.js";

const metadata = (
  id: string,
  capabilities: string[],
): CatalogSkillMetadata => ({
  id,
  name: id,
  description: "A shared description",
  capabilities,
  revision: "1.0.0",
  trustAtPublication: "trusted",
  currentAdvisoryStatus: "available",
});

describe("rankSkills", () => {
  it("uses lexical relevance before stable skill-id tie breaking", () => {
    const skills = [
      metadata("zeta-review", ["typescript", "review"]),
      metadata("alpha-review", ["typescript", "review"]),
      metadata("database-review", ["postgres", "schema"]),
    ];

    const first = rankSkills(skills, "Review strict TypeScript changes", 3);
    const second = rankSkills(skills, "Review strict TypeScript changes", 3);

    expect(first).toEqual(second);
    expect(first.map((result) => result.skill.id)).toEqual([
      "alpha-review",
      "zeta-review",
      "database-review",
    ]);
  });

  it("omits revoked revisions", () => {
    const available = metadata("available-review", ["review"]);
    const revoked = {
      ...metadata("revoked-review", ["review"]),
      currentAdvisoryStatus: "revoked" as const,
    };

    expect(rankSkills([revoked, available], "review", 10)).toHaveLength(1);
    expect(rankSkills([revoked, available], "review", 10)[0]?.skill.id).toBe(
      "available-review",
    );
  });
});
