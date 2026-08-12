import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evaluateGitHubImportSearch,
  loadGitHubImportJourneyMatrix,
  loadGitHubImportSearchCorpus,
  validateGitHubImportEvaluation,
} from "../../src/evaluation/github-import-runner.js";
import { FakeRepositoryMemoryStore } from "../helpers/memory-store.js";
import {
  createPublishedImportedCatalog,
  type PublishedImportedCatalog,
} from "../helpers/published-imported-catalog.js";

describe("frozen GitHub import search evaluation", () => {
  let catalog: PublishedImportedCatalog;

  beforeAll(async () => {
    catalog = await createPublishedImportedCatalog();
  }, 120_000);
  afterAll(async () => catalog.database.close());

  it("covers all 25 skills with at least 40 cases and enforces 90%", async () => {
    const corpus = loadGitHubImportSearchCorpus(process.cwd());
    const journeys = loadGitHubImportJourneyMatrix(process.cwd());
    await validateGitHubImportEvaluation(catalog.provider, corpus, journeys);
    const callsBefore = catalog.githubCallCount();
    const result = await evaluateGitHubImportSearch(
      catalog.provider,
      new FakeRepositoryMemoryStore(),
      corpus,
    );

    expect(result.total).toBeGreaterThanOrEqual(40);
    expect(result.successRate).toBeGreaterThanOrEqual(
      corpus.minimumSuccessRate,
    );
    expect(catalog.githubCallCount()).toBe(callsBefore);
  });
});
