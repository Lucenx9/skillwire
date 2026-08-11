import { describe, expect, it } from "vitest";

import { loadVerifiedCatalogProvider } from "../../src/catalog/version-controlled-provider.js";
import {
  evaluateThreeCallJourneys,
  loadJourneyEvaluationMatrix,
  validateJourneyEvaluationMatrix,
} from "../../src/evaluation/three-call-journey-runner.js";

describe("frozen progressive journey evaluation", () => {
  it("completes at least 90% within one search, one load, and one resource read", async () => {
    const provider = loadVerifiedCatalogProvider(
      process.cwd(),
      "launch-catalog-v1",
    );
    const matrix = validateJourneyEvaluationMatrix(
      loadJourneyEvaluationMatrix(process.cwd()),
      provider,
    );
    const result = await evaluateThreeCallJourneys(provider, matrix);

    expect(result.total).toBeGreaterThanOrEqual(20);
    expect(result.successRate).toBeGreaterThanOrEqual(0.9);
    expect(result.cases.every((entry) => entry.operationCount <= 3)).toBe(true);
  });
});
