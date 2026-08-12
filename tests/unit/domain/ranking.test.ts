import { describe, expect, it } from "vitest";

import type { CatalogSkillMetadata } from "../../../src/domain/catalog/types.js";
import {
  MINIMUM_RELEVANCE_SCORE,
  rankSkills,
} from "../../../src/domain/catalog/ranking.js";

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
  it("publishes the existing positive textual relevance threshold", () => {
    expect(MINIMUM_RELEVANCE_SCORE).toBe(1);
  });

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

  it("uses bounded outcome boosts only after lexical relevance", () => {
    const relevant = metadata("beta-tie", ["typescript", "review"]);
    const usefulTie = metadata("zeta-tie", ["typescript", "review"]);
    const neutralTie = metadata("alpha-tie", ["typescript", "review"]);
    const unsuccessfulTie = metadata("middle-tie", ["typescript", "review"]);
    const irrelevantUseful = metadata("irrelevant-useful", ["gardening"]);

    const ranked = rankSkills(
      [irrelevantUseful, neutralTie, unsuccessfulTie, usefulTie, relevant],
      "TypeScript review",
      5,
      [
        {
          skillId: usefulTie.id,
          revision: usefulTie.revision,
          outcome: "useful",
        },
        {
          skillId: neutralTie.id,
          revision: neutralTie.revision,
          outcome: "neutral",
        },
        {
          skillId: unsuccessfulTie.id,
          revision: unsuccessfulTie.revision,
          outcome: "unsuccessful",
        },
        {
          skillId: irrelevantUseful.id,
          revision: irrelevantUseful.revision,
          outcome: "useful",
        },
      ],
    );

    expect(ranked.map((entry) => entry.skill.id)).toEqual([
      "zeta-tie",
      "alpha-tie",
      "beta-tie",
      "middle-tie",
    ]);
  });

  it("returns no candidates when every skill has zero textual relevance", () => {
    const remembered = metadata("remembered-review", ["typescript"]);

    expect(
      rankSkills([remembered], "quasar xylophone", 10, [
        {
          skillId: remembered.id,
          revision: remembered.revision,
          outcome: "useful",
        },
      ]),
    ).toEqual([]);
  });

  it("does not treat common connector words as positive relevance", () => {
    const skills = [
      {
        ...metadata("upgrade-planning", ["dependency upgrades"]),
        description:
          "Plan dependency upgrades with compatibility tests and rollback.",
      },
    ];

    expect(
      rankSkills(skills, "Alphabetize apple, banana, and cherry.", 10),
    ).toEqual([]);
    expect(rankSkills(skills, "Replace commas with semicolons.", 10)).toEqual(
      [],
    );
  });

  it("removes zero-score entries before applying the result limit", () => {
    const irrelevant = metadata("alpha-irrelevant", ["gardening"]);
    const relevant = metadata("zeta-relevant", ["typescript"]);

    expect(rankSkills([irrelevant, relevant], "TypeScript", 1)).toMatchObject([
      {
        skill: { id: "zeta-relevant" },
      },
    ]);
    expect(rankSkills([irrelevant, relevant], "TypeScript", 1)[0]?.score).toBe(
      12,
    );
  });
});
