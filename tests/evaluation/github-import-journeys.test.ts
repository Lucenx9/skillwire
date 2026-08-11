import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evaluateGitHubImportJourneys,
  loadGitHubImportJourneyMatrix,
  loadGitHubImportSearchCorpus,
  validateGitHubImportEvaluation,
} from "../../src/evaluation/github-import-runner.js";
import { FakeRepositoryMemoryStore } from "../helpers/memory-store.js";
import {
  createPublishedImportedCatalog,
  type PublishedImportedCatalog,
} from "../helpers/published-imported-catalog.js";

describe("frozen GitHub import progressive journey evaluation", () => {
  let catalog: PublishedImportedCatalog;

  beforeAll(async () => {
    catalog = await createPublishedImportedCatalog();
  }, 120_000);
  afterAll(async () => catalog.database.close());

  it("completes all 25 journeys in at most search, load, and one resource call", async () => {
    const corpus = loadGitHubImportSearchCorpus(process.cwd());
    const matrix = loadGitHubImportJourneyMatrix(process.cwd());
    await validateGitHubImportEvaluation(catalog.provider, corpus, matrix);
    const result = await evaluateGitHubImportJourneys(
      catalog.provider,
      new FakeRepositoryMemoryStore(),
      matrix,
    );

    expect(result.total).toBeGreaterThanOrEqual(25);
    expect(result.successRate).toBeGreaterThanOrEqual(
      matrix.minimumSuccessRate,
    );
    expect(result.resourceCount).toBe(21);
  });
});
