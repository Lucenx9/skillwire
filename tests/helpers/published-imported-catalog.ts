import { SourceRegistrationService } from "../../src/application/services/source-registration-service.js";
import { SourceSynchronizationService } from "../../src/application/services/source-synchronization-service.js";
import { GitHubCommitTreeBlobReader } from "../../src/ingestion/github/commit-tree-blob-reader.js";
import { GitHubRestClient } from "../../src/ingestion/github/rest-client.js";
import { PostgresExternalCatalogStore } from "../../src/persistence/postgres/external-catalog-store.js";
import { PostgresImportedSkillCatalogProvider } from "../../src/persistence/postgres/imported-skill-catalog-provider.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { createGitHubIngestionFixture } from "./github-ingestion-fixture.js";

export interface PublishedImportedCatalog {
  readonly database: TestDatabase;
  readonly provider: PostgresImportedSkillCatalogProvider;
  readonly githubCallCount: () => number;
}

export async function createPublishedImportedCatalog(): Promise<PublishedImportedCatalog> {
  const database = await createTestDatabase();
  try {
    await database.migrate();
    const fixture = await createGitHubIngestionFixture();
    const github = new GitHubCommitTreeBlobReader(
      new GitHubRestClient({ fetchImplementation: fixture.fetch }),
    );
    const store = new PostgresExternalCatalogStore(database.pool);
    const registration = await new SourceRegistrationService(github, store).add(
      { owner: "mattpocock", repository: "skills" },
      "evaluation",
    );
    await new SourceSynchronizationService(github, store).sync(
      registration.sourceId,
    );
    return {
      database,
      provider: new PostgresImportedSkillCatalogProvider(database.pool),
      githubCallCount: () => fixture.calls.length,
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}
