import type { Pool } from "pg";

import { SourceDiscoveryService } from "../application/services/source-discovery-service.js";
import { SourceSynchronizationService } from "../application/services/source-synchronization-service.js";
import type { GitHubIngestionConfig } from "../config.js";
import { DEFAULT_INGESTION_BUDGETS } from "../domain/external-catalog/types.js";
import { GitHubSyncScheduler } from "../lifecycle/github-sync-scheduler.js";
import { PostgresExternalCatalogStore } from "../persistence/postgres/external-catalog-store.js";
import { PostgresGitHubSourceStore } from "../persistence/postgres/github-source-store.js";
import { PostgresSyncLeaseStore } from "../persistence/postgres/sync-lease-store.js";
import { GitHubCommitTreeBlobReader } from "./github/commit-tree-blob-reader.js";
import { GitHubSearchDiscoveryProvider } from "./github/discovery-provider.js";
import { GitHubRestClient } from "./github/rest-client.js";

export function createGitHubIngestionScheduler(
  pool: Pool,
  config: GitHubIngestionConfig,
): GitHubSyncScheduler {
  if (!config.enabled || config.token === undefined) {
    throw new Error("INVALID_GITHUB_INGESTION_CONFIGURATION");
  }
  if (
    config.requestTimeoutMilliseconds >= config.operationTimeoutMilliseconds ||
    config.discoveryQueries.length > config.maximumQueries
  ) {
    throw new Error("INVALID_GITHUB_INGESTION_CONFIGURATION");
  }
  const client = new GitHubRestClient({
    token: config.token,
    maximumResponseBytes: config.maximumResponseBytes,
    maximumAttempts: config.maximumAttempts,
    requestTimeoutMs: config.requestTimeoutMilliseconds,
  });
  const reader = new GitHubCommitTreeBlobReader(
    client,
    config.maximumTreeEntries,
  );
  const sourceStore = new PostgresGitHubSourceStore(pool);
  const catalogStore = new PostgresExternalCatalogStore(pool);
  const discoveryConfiguration = {
    querySetId: "skillwire-supported-layouts-v1",
    queries: config.discoveryQueries.map((query) => ({
      query,
      evidenceKind: query.includes("plugin.json")
        ? ("claude-plugin-manifest" as const)
        : ("nested-skill-document" as const),
    })),
    maximumQueries: config.maximumQueries,
    maximumPagesPerQuery: config.maximumPagesPerQuery,
    resultsPerPage: config.resultsPerPage,
    maximumResults: config.maximumResults,
    maximumRequests: config.maximumRequests,
    maximumResponseBytes: config.maximumResponseBytes,
  };
  const discovery = new SourceDiscoveryService(
    new GitHubSearchDiscoveryProvider(
      client,
      discoveryConfiguration,
      sourceStore,
    ),
    reader,
    sourceStore,
    discoveryConfiguration.querySetId,
    {
      maximumQueries: discoveryConfiguration.maximumQueries,
      maximumPages:
        discoveryConfiguration.maximumQueries *
        discoveryConfiguration.maximumPagesPerQuery,
      maximumResults: discoveryConfiguration.maximumResults,
      maximumRequests: discoveryConfiguration.maximumRequests,
      maximumResponseBytes: discoveryConfiguration.maximumResponseBytes,
    },
  );
  return new GitHubSyncScheduler(
    new PostgresSyncLeaseStore(pool),
    sourceStore,
    discovery,
    sourceStore,
    new SourceSynchronizationService(reader, catalogStore, {
      ...DEFAULT_INGESTION_BUDGETS,
      maximumRequests: config.maximumRequests,
      maximumResponseBytes: config.maximumResponseBytes,
      maximumTreeEntries: config.maximumTreeEntries,
      maximumCandidates: config.maximumCandidates,
      maximumResourcesPerSkill: config.maximumResourcesPerSkill,
      maximumDependenciesPerSkill: config.maximumDependenciesPerSkill,
      maximumTextBytes: config.maximumTextBytes,
      maximumBundleBytes: config.maximumBundleBytes,
      maximumRepositoryBytes: config.maximumRepositoryBytes,
      maximumRetries: config.maximumAttempts - 1,
    }),
    {
      leaseDurationMs: config.leaseDurationMilliseconds,
      sourceCadenceMs: config.sourceCadenceMilliseconds,
      discoveryCadenceMs: config.discoveryCadenceMilliseconds,
      maximumSourcesPerTick: config.maximumSourcesPerTick,
      operationTimeoutMs: config.operationTimeoutMilliseconds,
      maximumAttempts: config.maximumAttempts,
      maximumConcurrentJobs: config.globalJobs,
    },
  );
}
