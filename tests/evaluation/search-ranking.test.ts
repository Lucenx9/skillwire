import { describe, expect, it } from "vitest";

import { loadVerifiedCatalogProvider } from "../../src/catalog/version-controlled-provider.js";
import {
  evaluateSearchRanking,
  loadSearchEvaluationCorpus,
  validateSearchEvaluationCorpus,
} from "../../src/evaluation/search-ranking-runner.js";

describe("frozen search evaluation", () => {
  it("places the expected skill in the top three for at least 90% of cases", () => {
    const provider = loadVerifiedCatalogProvider(
      process.cwd(),
      "launch-catalog-v1",
    );
    const corpus = validateSearchEvaluationCorpus(
      loadSearchEvaluationCorpus(process.cwd()),
      provider.listMetadata(),
    );
    const result = evaluateSearchRanking(provider.listMetadata(), corpus);

    expect(result.total).toBeGreaterThanOrEqual(30);
    expect(result.successRate).toBeGreaterThanOrEqual(0.9);
  });
});
