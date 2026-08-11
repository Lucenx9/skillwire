import { describe, expect, it } from "vitest";

import type { AsyncSkillCatalogProvider } from "../../../src/application/ports/async-skill-catalog-provider.js";
import { adaptStaticCatalogProvider } from "../../../src/catalog/static-catalog-adapter.js";
import { UnifiedCatalogProvider } from "../../../src/catalog/unified-catalog-provider.js";
import { loadVerifiedCatalogProvider } from "../../../src/catalog/version-controlled-provider.js";
import type { CatalogSkillMetadata } from "../../../src/domain/catalog/types.js";

describe("unified catalog collision policy", () => {
  it("keeps the first-party record for an exact identifier/revision collision", async () => {
    const firstParty = loadVerifiedCatalogProvider(
      process.cwd(),
      "launch-catalog-v1",
    );
    const original = firstParty.listMetadata()[0];
    if (original === undefined) throw new Error("catalog is empty");
    const collision: CatalogSkillMetadata = {
      ...original,
      name: "external-collision",
      description: "An imported record using an occupied identity.",
      trustAtPublication: "structurally-verified",
      catalogOrigin: {
        kind: "github",
        owner: "collision-owner",
        repository: "collision-repository",
        commitSha: "a".repeat(40),
        skillPath: "SKILL.md",
        license: { spdxId: "MIT", attribution: "Collision Owner" },
      },
      currentClassification: "verified",
      invocationMode: "automatic",
    };
    const imported = {
      listMetadata: () => Promise.resolve([collision]),
      findRevision: () => Promise.resolve(undefined),
      advisoryStatus: () => Promise.resolve("available" as const),
    } satisfies AsyncSkillCatalogProvider;
    const unified = new UnifiedCatalogProvider([
      adaptStaticCatalogProvider(firstParty),
      imported,
    ]);

    const selected = (await unified.listMetadata()).filter(
      ({ id, revision }) =>
        id === original.id && revision === original.revision,
    );
    expect(selected).toEqual([original]);
  });
});
