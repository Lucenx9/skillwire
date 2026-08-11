import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  AdministrativeSource,
  ExternalCatalogStore,
  SourceRegistration,
} from "../../application/ports/external-catalog-store.js";
import type { OperationContext } from "../../application/ports/github-source-provider.js";
import type {
  DiscoveryCompletion,
  DiscoveryRunBudgets,
  QueuedDiscoveryRun,
  SourceDiscoveryStore,
} from "../../application/ports/source-discovery-store.js";
import type { SyncLease } from "../../application/ports/sync-lease-store.js";
import type { GitHubRepositoryIdentity } from "../../domain/external-catalog/types.js";
import type { DiscoveryPageCacheEntry } from "../../ingestion/github/discovery-provider.js";
import type { GitHubSearchPage } from "../../ingestion/github/rest-client.js";
import { assertLeaseHeld } from "./lease-fencing.js";
import { requestTransaction } from "./request-transaction.js";

interface SourceRow {
  readonly id: string;
  readonly github_repository_id: string;
  readonly owner: string;
  readonly repository: string;
  readonly default_branch: string;
  readonly metadata_etag: string | null;
  readonly metadata_cache_sha256: string | null;
}

interface AdministrativeSourceRow extends SourceRow {
  readonly source_classification: AdministrativeSource["classification"];
  readonly registered: boolean;
}

export class PostgresGitHubSourceStore
  implements
    Pick<ExternalCatalogStore, "registerSource" | "listSources">,
    SourceDiscoveryStore
{
  constructor(private readonly pool: Pool) {}

  async registerSource(
    repository: GitHubRepositoryIdentity,
    registeredBy: string,
    context: OperationContext = {},
  ): Promise<SourceRegistration> {
    return requestTransaction(this.pool, context, (client) =>
      this.#registerSource(client, repository, registeredBy),
    );
  }

  async #registerSource(
    client: PoolClient,
    repository: GitHubRepositoryIdentity,
    registeredBy: string,
  ): Promise<SourceRegistration> {
    const id = randomUUID();
    const result = await client.query<SourceRow>(
      `
        INSERT INTO github_sources (
          id, github_repository_id, owner, repository,
          normalized_owner, normalized_repository, default_branch
        ) VALUES ($1, $2, $3, $4, lower($3), lower($4), $5)
        ON CONFLICT (github_repository_id) DO UPDATE SET
          owner = EXCLUDED.owner,
          repository = EXCLUDED.repository,
          normalized_owner = EXCLUDED.normalized_owner,
          normalized_repository = EXCLUDED.normalized_repository,
          default_branch = EXCLUDED.default_branch,
          last_observed_at = statement_timestamp()
        RETURNING id, github_repository_id, owner, repository, default_branch, (xmax = 0) AS created
      `,
      [
        id,
        repository.repositoryId,
        repository.owner,
        repository.repository,
        repository.defaultBranch,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("SOURCE_REGISTRATION_FAILED");
    await client.query(
      `
        INSERT INTO github_source_aliases (
          normalized_owner, normalized_repository, source_id
        ) VALUES (lower($1), lower($2), $3)
        ON CONFLICT (normalized_owner, normalized_repository) DO UPDATE SET
          last_observed_at = statement_timestamp()
        WHERE github_source_aliases.source_id = EXCLUDED.source_id
      `,
      [repository.owner, repository.repository, row.id],
    );
    const registration = await client.query(
      `
        INSERT INTO github_source_registrations (source_id, registered_by)
        VALUES ($1, $2)
        ON CONFLICT (source_id) DO NOTHING
      `,
      [row.id, registeredBy],
    );
    return {
      sourceId: row.id,
      repository: {
        repositoryId: Number(row.github_repository_id),
        owner: row.owner,
        repository: row.repository,
        defaultBranch: row.default_branch,
      },
      created: registration.rowCount === 1,
    };
  }

  listSources(
    context: OperationContext = {},
  ): Promise<readonly SourceRegistration[]> {
    return requestTransaction(this.pool, context, async (client) => {
      const result = await client.query<SourceRow>(
        `
          SELECT id, github_repository_id, owner, repository, default_branch,
                 metadata_etag, metadata_cache_sha256
          FROM github_sources s
          JOIN github_source_registrations r ON r.source_id = s.id
          ORDER BY s.normalized_owner, s.normalized_repository
          LIMIT 100
        `,
      );
      return result.rows.map((row) => ({
        sourceId: row.id,
        repository: {
          repositoryId: Number(row.github_repository_id),
          owner: row.owner,
          repository: row.repository,
          defaultBranch: row.default_branch,
        },
        created: false,
        ...(row.metadata_etag === null
          ? {}
          : { metadataEtag: row.metadata_etag }),
        ...(row.metadata_cache_sha256 === null
          ? {}
          : { metadataCacheSha256: row.metadata_cache_sha256 }),
      }));
    });
  }

  listAdministrativeSources(
    classification?: AdministrativeSource["classification"],
    context: OperationContext = {},
  ): Promise<readonly AdministrativeSource[]> {
    return requestTransaction(this.pool, context, async (client) => {
      const result = await client.query<AdministrativeSourceRow>(
        `SELECT s.id,s.github_repository_id,s.owner,s.repository,s.default_branch,
                s.metadata_etag,s.metadata_cache_sha256,s.source_classification,
                (r.source_id IS NOT NULL) AS registered
         FROM github_sources s
         LEFT JOIN github_source_registrations r ON r.source_id=s.id
         WHERE ($1::text IS NULL OR s.source_classification=$1)
         ORDER BY s.normalized_owner,s.normalized_repository
         LIMIT 100`,
        [classification ?? null],
      );
      return result.rows.map((row) => ({
        sourceId: row.id,
        repository: {
          repositoryId: Number(row.github_repository_id),
          owner: row.owner,
          repository: row.repository,
          defaultBranch: row.default_branch,
        },
        classification: row.source_classification,
        registered: row.registered,
      }));
    });
  }

  enqueueDiscovery(
    querySetSha256: string,
    budgets: DiscoveryRunBudgets,
    context: OperationContext = {},
  ): Promise<QueuedDiscoveryRun> {
    return requestTransaction(this.pool, context, async (client) => {
      const active = await client.query<{
        id: string;
        state: QueuedDiscoveryRun["state"];
      }>(
        `SELECT id, state FROM github_discovery_runs
         WHERE state IN ('queued', 'running') ORDER BY queued_at LIMIT 1 FOR UPDATE`,
      );
      const existing = active.rows[0];
      if (existing !== undefined) {
        return { runId: existing.id, state: existing.state, created: false };
      }
      const id = randomUUID();
      await client.query(
        `
          INSERT INTO github_discovery_runs (
            id, state, query_set_sha256, policy_version,
            maximum_queries, maximum_pages, maximum_results,
            maximum_requests, maximum_response_bytes
          ) VALUES ($1, 'queued', $2, 'external-policy-v1', $3, $4, $5, $6, $7)
        `,
        [
          id,
          querySetSha256,
          budgets.maximumQueries,
          budgets.maximumPages,
          budgets.maximumResults,
          budgets.maximumRequests,
          budgets.maximumResponseBytes,
        ],
      );
      return { runId: id, state: "queued", created: true };
    });
  }

  enqueueScheduledDiscovery(
    querySetSha256: string,
    budgets: DiscoveryRunBudgets,
    cadenceMs: number,
    context: OperationContext = {},
  ): Promise<QueuedDiscoveryRun> {
    if (
      !Number.isInteger(cadenceMs) ||
      cadenceMs < 60_000 ||
      cadenceMs > 604_800_000
    ) {
      throw new Error("INVALID_DISCOVERY_CADENCE");
    }
    return requestTransaction(this.pool, context, async (client) => {
      const active = await client.query<{
        id: string;
        state: QueuedDiscoveryRun["state"];
      }>(
        `SELECT id,state FROM github_discovery_runs
         WHERE state IN ('queued','running') ORDER BY queued_at LIMIT 1 FOR UPDATE`,
      );
      const activeRow = active.rows[0];
      if (activeRow !== undefined) {
        return { runId: activeRow.id, state: activeRow.state, created: false };
      }
      const recent = await client.query<{
        id: string;
        state: QueuedDiscoveryRun["state"];
      }>(
        `SELECT id,state FROM github_discovery_runs
         WHERE COALESCE(completed_at,queued_at) > clock_timestamp() - $1 * interval '1 millisecond'
         ORDER BY COALESCE(completed_at,queued_at) DESC LIMIT 1`,
        [cadenceMs],
      );
      const recentRow = recent.rows[0];
      if (recentRow !== undefined) {
        return { runId: recentRow.id, state: recentRow.state, created: false };
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO github_discovery_runs (
           id,state,query_set_sha256,policy_version,maximum_queries,maximum_pages,
           maximum_results,maximum_requests,maximum_response_bytes
         ) VALUES ($1,'queued',$2,'external-policy-v1',$3,$4,$5,$6,$7)`,
        [
          id,
          querySetSha256,
          budgets.maximumQueries,
          budgets.maximumPages,
          budgets.maximumResults,
          budgets.maximumRequests,
          budgets.maximumResponseBytes,
        ],
      );
      return { runId: id, state: "queued", created: true };
    });
  }

  markDiscoveryRunning(
    runId: string,
    lease: SyncLease,
    context: OperationContext = {},
  ): Promise<void> {
    return requestTransaction(this.pool, context, async (client) => {
      await assertLeaseHeld(client, lease);
      const result = await client.query(
        `
          UPDATE github_discovery_runs SET
            state = 'running', holder_id = $2, fencing_token = $3,
            started_at = COALESCE(started_at, statement_timestamp())
          WHERE id = $1 AND state IN ('queued', 'running')
            AND (fencing_token IS NULL OR fencing_token <= $3)
        `,
        [runId, lease.holderId, lease.fencingToken.toString()],
      );
      if (result.rowCount !== 1) throw new Error("DISCOVERY_RUN_NOT_CLAIMABLE");
    });
  }

  completeDiscovery(
    runId: string,
    lease: SyncLease,
    completion: DiscoveryCompletion,
    context: OperationContext = {},
  ): Promise<void> {
    return requestTransaction(this.pool, context, async (client) => {
      await assertLeaseHeld(client, lease);
      for (const discovered of completion.sources) {
        const repository = discovered.repository;
        const sourceId = randomUUID();
        const source = await client.query<{ id: string }>(
          `
            INSERT INTO github_sources (
              id, github_repository_id, owner, repository,
              normalized_owner, normalized_repository, default_branch
            ) VALUES ($1, $2, $3, $4, lower($3), lower($4), $5)
            ON CONFLICT (github_repository_id) DO UPDATE SET
              owner = EXCLUDED.owner,
              repository = EXCLUDED.repository,
              normalized_owner = EXCLUDED.normalized_owner,
              normalized_repository = EXCLUDED.normalized_repository,
              default_branch = EXCLUDED.default_branch,
              last_observed_at = statement_timestamp()
            RETURNING id
          `,
          [
            sourceId,
            repository.repositoryId,
            repository.owner,
            repository.repository,
            repository.defaultBranch,
          ],
        );
        const storedSourceId = source.rows[0]?.id;
        if (storedSourceId === undefined)
          throw new Error("SOURCE_DISCOVERY_FAILED");
        await client.query(
          `
            INSERT INTO github_source_aliases (
              normalized_owner, normalized_repository, source_id, alias_reason
            ) VALUES (lower($1), lower($2), $3, 'canonical')
            ON CONFLICT (normalized_owner, normalized_repository) DO UPDATE SET
              last_observed_at = statement_timestamp()
            WHERE github_source_aliases.source_id = EXCLUDED.source_id
          `,
          [repository.owner, repository.repository, storedSourceId],
        );
        for (const evidence of discovered.evidence) {
          await client.query(
            `
              INSERT INTO github_discovery_evidence (
                id, discovery_run_id, source_id, evidence_kind,
                normalized_path_sha256, safe_basename
              ) VALUES ($1,$2,$3,$4,$5,$6)
              ON CONFLICT DO NOTHING
            `,
            [
              randomUUID(),
              runId,
              storedSourceId,
              evidence.kind,
              evidence.pathHash,
              evidence.basename,
            ],
          );
        }
      }
      const state = completion.incomplete ? "failed" : "succeeded";
      const terminalCode = completion.incomplete
        ? "GITHUB_SEARCH_INCOMPLETE"
        : null;
      const updated = await client.query(
        `
          UPDATE github_discovery_runs SET
            state = $4, terminal_code = $5,
            query_count = $6, page_count = $7, result_count = $8,
            unique_source_count = $9, request_count = $10,
            retry_count = $11, response_bytes = $12,
            completed_at = statement_timestamp()
          WHERE id = $1 AND state = 'running' AND holder_id = $2 AND fencing_token = $3
        `,
        [
          runId,
          lease.holderId,
          lease.fencingToken.toString(),
          state,
          terminalCode,
          completion.counters.queries,
          completion.counters.pages,
          completion.counters.results,
          completion.counters.uniqueRepositories,
          completion.counters.requests,
          completion.counters.retries,
          completion.counters.responseBytes,
        ],
      );
      if (updated.rowCount !== 1) throw new Error("LEASE_LOST");
    });
  }

  failDiscovery(
    runId: string,
    lease: SyncLease,
    code: string,
    cancelled: boolean,
    context: OperationContext = {},
  ): Promise<void> {
    return requestTransaction(this.pool, context, async (client) => {
      await assertLeaseHeld(client, lease);
      const result = await client.query(
        `
          UPDATE github_discovery_runs SET
            state = $4, terminal_code = $5, completed_at = statement_timestamp()
          WHERE id = $1 AND state = 'running' AND holder_id = $2 AND fencing_token = $3
        `,
        [
          runId,
          lease.holderId,
          lease.fencingToken.toString(),
          cancelled ? "cancelled" : "failed",
          code,
        ],
      );
      if (result.rowCount !== 1) throw new Error("LEASE_LOST");
    });
  }

  claimQueuedDiscovery(
    context: OperationContext = {},
  ): Promise<string | undefined> {
    return requestTransaction(this.pool, context, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM github_discovery_runs
         WHERE state = 'queued' ORDER BY queued_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      return result.rows[0]?.id;
    });
  }

  get(
    key: string,
    context: OperationContext = {},
  ): Promise<DiscoveryPageCacheEntry | undefined> {
    return requestTransaction(this.pool, context, async (client) => {
      const cacheKey = cacheKeySha(key);
      const result = await client.query<{
        etag: string;
        body_sha256: string;
        validated_body: GitHubSearchPage;
      }>(
        "SELECT etag, body_sha256, validated_body FROM github_metadata_cache WHERE cache_key_sha256 = $1",
        [cacheKey],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            etag: row.etag,
            bodySha256: row.body_sha256,
            page: row.validated_body,
          };
    });
  }

  put(
    key: string,
    entry: DiscoveryPageCacheEntry,
    context: OperationContext = {},
  ): Promise<void> {
    return requestTransaction(this.pool, context, async (client) => {
      await client.query(
        `
          INSERT INTO github_metadata_cache (
            cache_key_sha256, etag, body_sha256, validated_body
          ) VALUES ($1,$2,$3,$4)
          ON CONFLICT (cache_key_sha256) DO UPDATE SET
            etag = EXCLUDED.etag,
            body_sha256 = EXCLUDED.body_sha256,
            validated_body = EXCLUDED.validated_body,
            updated_at = statement_timestamp()
        `,
        [
          cacheKeySha(key),
          entry.etag,
          entry.bodySha256,
          JSON.stringify(entry.page),
        ],
      );
    });
  }

  listDueSourceIds(
    limit: number,
    context: OperationContext = {},
  ): Promise<readonly string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("INVALID_SCHEDULE_LIMIT");
    }
    return requestTransaction(this.pool, context, async (client) => {
      const result = await client.query<{ source_id: string }>(
        `
          SELECT source_id
          FROM github_source_registrations
          WHERE synchronization_enabled AND next_sync_at <= clock_timestamp()
          ORDER BY next_sync_at, source_id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        `,
        [limit],
      );
      return result.rows.map(({ source_id }) => source_id);
    });
  }

  scheduleNextSource(
    sourceId: string,
    delayMs: number,
    context: OperationContext = {},
  ): Promise<void> {
    if (
      !Number.isInteger(delayMs) ||
      delayMs < 60_000 ||
      delayMs > 604_800_000
    ) {
      throw new Error("INVALID_SYNC_SCHEDULE");
    }
    return requestTransaction(this.pool, context, async (client) => {
      await client.query(
        `
          UPDATE github_source_registrations SET
            next_sync_at = clock_timestamp() + $2 * interval '1 millisecond'
          WHERE source_id = $1
        `,
        [sourceId, delayMs],
      );
    });
  }
}

function cacheKeySha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
