import { describe, expect, it } from "vitest";

import { resolveInternalDependencies } from "../../../src/domain/external-catalog/dependency-resolver.js";

describe("same-source dependency resolver", () => {
  it("resolves only exact unique names in the same snapshot", () => {
    expect(
      resolveInternalDependencies(
        ["grill-with-docs", "grilling", "domain-modeling"],
        "grill-with-docs",
        [
          {
            skillName: "grilling",
            required: true,
            evidenceKind: "explicit-invocation",
            evidenceLocator: "instructions:1",
          },
          {
            skillName: "domain-modeling",
            required: true,
            evidenceKind: "frontmatter",
            evidenceLocator: "frontmatter:dependencies:0",
          },
        ],
      ).dependencies.map(({ skillName }) => skillName),
    ).toEqual(["domain-modeling", "grilling"]);
  });

  it("reports missing required declarations without inventing an edge", () => {
    const result = resolveInternalDependencies(["caller"], "caller", [
      {
        skillName: "missing",
        required: true,
        evidenceKind: "frontmatter",
        evidenceLocator: "frontmatter:dependencies:0",
      },
    ]);
    expect(result.dependencies).toEqual([]);
    expect(result.findings.map(({ code }) => code)).toEqual([
      "DEPENDENCY_MISSING",
    ]);
  });
});
