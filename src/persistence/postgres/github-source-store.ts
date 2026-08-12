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
import type {
  ClaimedSyncRun,
  DurableSyncTrigger,
  QueuedSyncRun,
  SyncRunStore,
  SyncRunSummary,
} from "../../application/ports/sync-run-store.js";
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
    SourceDiscoveryStore,
    SyncRunStore
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
          last_observed_at = statement_timestamp(),
          unavailable_confirmation_count = 0,
          unavailable_first_observed_at = NULL,
          unavailable_last_observed_at = NULL
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
    sourceId?: string,
  ): Promise<readonly AdministrativeSource[]> {
    return requestTransaction(this.pool, context, async (client) => {
      const result = await client.query<AdministrativeSourceRow>(
        `SELECT s.id,s.github_repository_id,s.owner,s.repository,s.default_branch,
                s.metadata_etag,s.metadata_cache_sha256,s.source_classification,
                (r.source_id IS NOT NULL) AS registered
         FROM github_sources s
         LEFT JOIN github_source_registrations r ON r.source_id=s.id
         WHERE ($1::text IS NULL OR s.source_classification=$1)
           AND ($2::uuid IS NULL OR s.id=$2)
         ORDER BY s.normalized_owner,s.normalized_repository
         LIMIT 100`,
        [classification ?? null, sourceId ?? null],
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
              last_observed_at = statement_timestamp(),
              unavailable_confirmation_count = 0,
              unavailable_first_observed_at = NULL,
              unavailable_last_observed_at = NULL
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

  enqueueSync(
    sourceId: string,
    trigger: DurableSyncTrigger,
    context: OperationContext = {},
  ): Promise<QueuedSyncRun> {
    return this.#enqueueSync(
      sourceId,
      trigger,
      undefined,
      undefined,
      undefined,
      context,
    );
  }

  enqueueCandidateVerification(
    candidateId: string,
    context: OperationContext = {},
  ): Promise<QueuedSyncRun> {
    return requestTransaction(this.pool, context, async (client) => {
      const target = await client.query<{
        source_id: string;
        commit_sha: string;
        origin_github_repository_id: string;
        origin_owner: string;
        origin_repository: string;
      }>(
        `SELECT snapshot.source_id,snapshot.commit_sha,
                snapshot.origin_github_repository_id::text,
                snapshot.origin_owner,snapshot.origin_repository
         FROM external_import_candidates candidate
         JOIN external_source_snapshots snapshot ON snapshot.id=candidate.snapshot_id
         WHERE candidate.id=$1`,
        [candidateId],
      );
      const row = target.rows[0];
      if (row === undefined) throw new Error("NOT_FOUND");
      return this.#enqueueSyncInTransaction(
        client,
        row.source_id,
        "administrator",
        candidateId,
        row.commit_sha,
        {
          repositoryId: Number(row.origin_github_repository_id),
          owner: row.origin_owner,
          repository: row.origin_repository,
        },
      );
    });
  }

  #enqueueSync(
    sourceId: string,
    trigger: DurableSyncTrigger,
    candidateId: string | undefined,
    commitSha: string | undefined,
    repository:
      | {
          readonly repositoryId: number;
          readonly owner: string;
          readonly repository: string;
        }
      | undefined,
    context: OperationContext,
  ): Promise<QueuedSyncRun> {
    return requestTransaction(this.pool, context, (client) =>
      this.#enqueueSyncInTransaction(
        client,
        sourceId,
        trigger,
        candidateId,
        commitSha,
        repository,
      ),
    );
  }

  async #enqueueSyncInTransaction(
    client: PoolClient,
    sourceId: string,
    trigger: DurableSyncTrigger,
    candidateId?: string,
    commitSha?: string,
    repository?: {
      readonly repositoryId: number;
      readonly owner: string;
      readonly repository: string;
    },
    nextAttemptAt?: Date,
    previousRunId?: string,
    initialAttemptCount = 0,
  ): Promise<QueuedSyncRun> {
    const source = await client.query(
      "SELECT id FROM github_sources WHERE id=$1",
      [sourceId],
    );
    if (source.rowCount !== 1) throw new Error("SOURCE_NOT_FOUND");
    const active = await client.query<{
      id: string;
      state: "queued" | "running";
      requested_candidate_id: string | null;
      requested_commit_sha: string | null;
      requested_repository_id: string | null;
      requested_owner: string | null;
      requested_repository: string | null;
      attempt_count: number;
    }>(
      `SELECT id,state,requested_candidate_id,requested_commit_sha,attempt_count,
              requested_repository_id::text,requested_owner,requested_repository
       FROM github_sync_runs
       WHERE source_id=$1 AND state IN ('queued','running')
       ORDER BY queued_at,id LIMIT 1 FOR UPDATE`,
      [sourceId],
    );
    const existing = active.rows[0];
    if (existing !== undefined) {
      if (
        candidateId !== undefined &&
        (existing.requested_candidate_id !== candidateId ||
          existing.requested_commit_sha !== commitSha)
      ) {
        throw new Error("CONFLICT");
      }
      return {
        runId: existing.id,
        sourceId,
        state: existing.state,
        created: false,
        attemptCount: existing.attempt_count,
        ...(existing.requested_candidate_id === null
          ? {}
          : { requestedCandidateId: existing.requested_candidate_id }),
        ...(existing.requested_commit_sha === null
          ? {}
          : { requestedCommitSha: existing.requested_commit_sha }),
        ...(existing.requested_repository_id === null ||
        existing.requested_owner === null ||
        existing.requested_repository === null
          ? {}
          : {
              requestedRepository: {
                repositoryId: Number(existing.requested_repository_id),
                owner: existing.requested_owner,
                repository: existing.requested_repository,
              },
            }),
      };
    }
    const runId = randomUUID();
    await client.query(
      `INSERT INTO github_sync_runs (
         id,source_id,trigger_kind,state,queued_at,next_attempt_at,
         requested_candidate_id,requested_commit_sha,previous_run_id
         ,requested_repository_id,requested_owner,requested_repository,attempt_count
       ) VALUES ($1,$2,$3,'queued',statement_timestamp(),COALESCE($4,statement_timestamp()),$5,$6,$7,$8,$9,$10,$11)`,
      [
        runId,
        sourceId,
        trigger,
        nextAttemptAt ?? null,
        candidateId ?? null,
        commitSha ?? null,
        previousRunId ?? null,
        repository?.repositoryId ?? null,
        repository?.owner ?? null,
        repository?.repository ?? null,
        initialAttemptCount,
      ],
    );
    return {
      runId,
      sourceId,
      state: "queued",
      created: true,
      attemptCount: initialAttemptCount,
      ...(candidateId === undefined
        ? {}
        : { requestedCandidateId: candidateId }),
      ...(commitSha === undefined ? {} : { requestedCommitSha: commitSha }),
      ...(repository === undefined ? {} : { requestedRepository: repository }),
    };
  }

  enqueueDueSourceSyncs(
    limit: number,
    context: OperationContext = {},
  ): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("INVALID_SCHEDULE_LIMIT");
    }
    return requestTransaction(this.pool, context, async (client) => {
      const due = await client.query<{ source_id: string }>(
        `SELECT registration.source_id
         FROM github_source_registrations registration
         WHERE registration.synchronization_enabled
           AND registration.next_sync_at <= clock_timestamp()
           AND NOT EXISTS (
             SELECT 1 FROM github_sync_runs run
             WHERE run.source_id=registration.source_id
               AND run.state IN ('queued','running')
           )
         ORDER BY registration.next_sync_at,registration.source_id
         LIMIT $1 FOR UPDATE OF registration SKIP LOCKED`,
        [limit],
      );
      for (const row of due.rows) {
        await this.#enqueueSyncInTransaction(
          client,
          row.source_id,
          "scheduled",
          undefined,
          undefined,
          undefined,
        );
      }
      return due.rows.length;
    });
  }

  claimQueuedSyncRuns(
    limit: number,
    context: OperationContext = {},
  ): Promise<readonly ClaimedSyncRun[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("INVALID_SCHEDULE_LIMIT");
    }
    return requestTransaction(this.pool, context, async (client) => {
      const result = await client.query<{
        id: string;
        source_id: string;
        requested_candidate_id: string | null;
        requested_commit_sha: string | null;
        requested_repository_id: string | null;
        requested_owner: string | null;
        requested_repository: string | null;
        attempt_count: number;
      }>(
        `SELECT id,source_id,requested_candidate_id,requested_commit_sha,attempt_count,
                requested_repository_id::text,requested_owner,requested_repository
         FROM github_sync_runs
         WHERE state='queued' AND next_attempt_at <= clock_timestamp()
         ORDER BY next_attempt_at,queued_at,id
         LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      return result.rows.map((row) => ({
        runId: row.id,
        sourceId: row.source_id,
        state: "queued" as const,
        created: false,
        attemptCount: row.attempt_count,
        ...(row.requested_candidate_id === null
          ? {}
          : { requestedCandidateId: row.requested_candidate_id }),
        ...(row.requested_commit_sha === null
          ? {}
          : { requestedCommitSha: row.requested_commit_sha }),
        ...(row.requested_repository_id === null ||
        row.requested_owner === null ||
        row.requested_repository === null
          ? {}
          : {
              requestedRepository: {
                repositoryId: Number(row.requested_repository_id),
                owner: row.requested_owner,
                repository: row.requested_repository,
              },
            }),
      }));
    });
  }

  markSyncRunning(
    runId: string,
    lease: SyncLease,
    context: OperationContext = {},
  ): Promise<void> {
    return requestTransaction(this.pool, context, async (client) => {
      await assertLeaseHeld(client, lease);
      const result = await client.query(
        `UPDATE github_sync_runs SET state='running',holder_id=$2,fencing_token=$3,
           attempt_count=attempt_count+1,started_at=statement_timestamp(),heartbeat_at=statement_timestamp()
         WHERE id=$1 AND state='queued'
           AND source_id=substring($4 from 6)::uuid`,
        [runId, lease.holderId, lease.fencingToken.toString(), lease.key],
      );
      if (result.rowCount !== 1) throw new Error("SYNC_RUN_NOT_CLAIMABLE");
      await assertLeaseHeld(client, lease);
    });
  }

  completeSyncRun(
    runId: string,
    lease: SyncLease,
    summary: SyncRunSummary,
    context: OperationContext = {},
  ): Promise<void> {
    return requestTransaction(this.pool, context, async (client) => {
      await assertLeaseHeld(client, lease);
      const state =
        summary.published + summary.reused > 0 ? "succeeded" : "quarantined";
      const result = await client.query(
        `UPDATE github_sync_runs SET state=$4,commit_sha=$5,tree_sha=$6,
           trace_count=$7,candidate_count=$8,resource_count=$9,request_count=$10,
           retry_count=$11,decoded_bytes=$12,summary=$13::jsonb,
           terminal_code=$14,terminal_at=statement_timestamp(),completed_at=statement_timestamp()
         WHERE id=$1 AND state='running' AND holder_id=$2 AND fencing_token=$3`,
        [
          runId,
          lease.holderId,
          lease.fencingToken.toString(),
          state,
          summary.commitSha ?? null,
          summary.treeSha ?? null,
          summary.published + summary.reused,
          summary.candidates,
          summary.resources,
          summary.requests,
          summary.retries,
          summary.responseBytes,
          JSON.stringify({
            published: summary.published,
            reused: summary.reused,
            quarantined: summary.quarantined,
          }),
          state === "quarantined" ? "VALIDATION_QUARANTINED" : null,
        ],
      );
      if (result.rowCount !== 1) throw new Error("LEASE_LOST");
      await client.query(
        `UPDATE github_source_registrations SET
           last_terminal_run_id=$2,
           next_sync_at=clock_timestamp()+synchronization_interval_seconds*interval '1 second'
         WHERE source_id=(SELECT source_id FROM github_sync_runs WHERE id=$1)`,
        [runId, runId],
      );
      await assertLeaseHeld(client, lease);
    });
  }

  failSyncRun(
    runId: string,
    lease: SyncLease,
    code: string,
    options: {
      readonly cancelled: boolean;
      readonly retryable: boolean;
      readonly retryAfterMilliseconds?: number | undefined;
    },
    context: OperationContext = {},
  ): Promise<void> {
    return requestTransaction(this.pool, context, async (client) => {
      await assertLeaseHeld(client, lease);
      const current = await client.query<{
        source_id: string;
        trigger_kind: DurableSyncTrigger;
        requested_candidate_id: string | null;
        requested_commit_sha: string | null;
        requested_repository_id: string | null;
        requested_owner: string | null;
        requested_repository: string | null;
        attempt_count: number;
      }>(
        `SELECT source_id,trigger_kind,requested_candidate_id,requested_commit_sha,
                requested_repository_id::text,requested_owner,requested_repository,attempt_count
         FROM github_sync_runs
         WHERE id=$1 AND state='running' AND holder_id=$2 AND fencing_token=$3
         FOR UPDATE`,
        [runId, lease.holderId, lease.fencingToken.toString()],
      );
      const row = current.rows[0];
      if (row === undefined) throw new Error("LEASE_LOST");
      const requestedDelay =
        options.retryAfterMilliseconds ??
        1_000 * 2 ** Math.min(row.attempt_count, 10);
      if (
        !Number.isFinite(requestedDelay) ||
        requestedDelay < 0 ||
        requestedDelay > 604_800_000
      ) {
        throw new Error("INVALID_RETRY_DELAY");
      }
      const delay = Math.max(1_000, requestedDelay);
      const nextAttempt = new Date(Date.now() + delay);
      await client.query(
        `UPDATE github_sync_runs SET state=$2,retryable=$3,terminal_code=$4,
           next_attempt_at=$5,terminal_at=statement_timestamp(),completed_at=statement_timestamp(),
           summary=$6::jsonb
         WHERE id=$1`,
        [
          runId,
          options.cancelled ? "cancelled" : "failed",
          options.retryable,
          code.slice(0, 80),
          nextAttempt,
          JSON.stringify({
            retryScheduled: options.retryable && !options.cancelled,
          }),
        ],
      );
      if (options.retryable && !options.cancelled) {
        await this.#enqueueSyncInTransaction(
          client,
          row.source_id,
          row.trigger_kind,
          row.requested_candidate_id ?? undefined,
          row.requested_commit_sha ?? undefined,
          row.requested_repository_id === null ||
            row.requested_owner === null ||
            row.requested_repository === null
            ? undefined
            : {
                repositoryId: Number(row.requested_repository_id),
                owner: row.requested_owner,
                repository: row.requested_repository,
              },
          nextAttempt,
          runId,
          row.attempt_count,
        );
      }
      await assertLeaseHeld(client, lease);
    });
  }

  quarantineSyncRun(
    runId: string,
    lease: SyncLease,
    reasonCode: string,
    context: OperationContext = {},
  ): Promise<void> {
    return requestTransaction(this.pool, context, async (client) => {
      await assertLeaseHeld(client, lease);
      const result = await client.query(
        `UPDATE github_sync_runs SET state='quarantined',retryable=false,
           terminal_code=$4,terminal_at=statement_timestamp(),completed_at=statement_timestamp(),
           summary='{"quarantined":1}'::jsonb
         WHERE id=$1 AND state='running' AND holder_id=$2 AND fencing_token=$3`,
        [
          runId,
          lease.holderId,
          lease.fencingToken.toString(),
          reasonCode.slice(0, 80),
        ],
      );
      if (result.rowCount !== 1) throw new Error("LEASE_LOST");
      await client.query(
        `INSERT INTO github_sync_candidate_results (
           id,sync_run_id,ordinal,outcome,reason_code,evidence_sha256
         ) VALUES ($1,$2,0,'quarantined',$3,$4)`,
        [
          randomUUID(),
          runId,
          reasonCode.slice(0, 80),
          cacheKeySha(`${runId}:${reasonCode}`),
        ],
      );
      await client.query(
        `UPDATE github_source_registrations SET
           last_terminal_run_id=$2,
           next_sync_at=clock_timestamp()+synchronization_interval_seconds*interval '1 second'
         WHERE source_id=(SELECT source_id FROM github_sync_runs WHERE id=$1)`,
        [runId, runId],
      );
      await assertLeaseHeld(client, lease);
    });
  }

  recoverAbandonedJobs(context: OperationContext = {}): Promise<number> {
    return requestTransaction(this.pool, context, async (client) => {
      const abandoned = await client.query<{
        id: string;
        source_id: string;
        trigger_kind: DurableSyncTrigger;
        requested_candidate_id: string | null;
        requested_commit_sha: string | null;
        requested_repository_id: string | null;
        requested_owner: string | null;
        requested_repository: string | null;
        attempt_count: number;
      }>(
        `SELECT run.id,run.source_id,run.trigger_kind,run.requested_candidate_id,run.requested_commit_sha,
                run.requested_repository_id::text,run.requested_owner,run.requested_repository,
                run.attempt_count
         FROM github_sync_runs run
         LEFT JOIN github_job_leases lease ON lease.lease_key='sync/'||run.source_id::text
         WHERE run.state='running' AND (
           lease.lease_key IS NULL OR lease.lease_expires_at <= clock_timestamp()
           OR lease.holder_id IS DISTINCT FROM run.holder_id
           OR lease.fencing_token IS DISTINCT FROM run.fencing_token
         )
         ORDER BY run.started_at,run.id FOR UPDATE OF run SKIP LOCKED`,
      );
      for (const run of abandoned.rows) {
        await client.query(
          `UPDATE github_sync_runs SET state='failed',retryable=true,
             terminal_code='RUN_ABANDONED',terminal_at=statement_timestamp(),
             completed_at=statement_timestamp(),summary='{"recovered":true}'::jsonb
           WHERE id=$1`,
          [run.id],
        );
        await this.#enqueueSyncInTransaction(
          client,
          run.source_id,
          run.trigger_kind,
          run.requested_candidate_id ?? undefined,
          run.requested_commit_sha ?? undefined,
          run.requested_repository_id === null ||
            run.requested_owner === null ||
            run.requested_repository === null
            ? undefined
            : {
                repositoryId: Number(run.requested_repository_id),
                owner: run.requested_owner,
                repository: run.requested_repository,
              },
          new Date(Date.now() + 1_000),
          run.id,
          run.attempt_count,
        );
      }
      const discovery = await client.query<{
        query_set_sha256: string;
        policy_version: string;
        maximum_queries: number;
        maximum_pages: number;
        maximum_results: number;
        maximum_requests: number;
        maximum_response_bytes: string;
      }>(
        `UPDATE github_discovery_runs run SET state='failed',terminal_code='RUN_ABANDONED',
           completed_at=statement_timestamp()
         WHERE run.state='running' AND NOT EXISTS (
           SELECT 1 FROM github_job_leases lease
           WHERE lease.lease_key='discovery' AND lease.holder_id=run.holder_id
             AND lease.fencing_token=run.fencing_token
             AND lease.lease_expires_at > clock_timestamp()
         )
         RETURNING query_set_sha256,policy_version,maximum_queries,maximum_pages,
                   maximum_results,maximum_requests,maximum_response_bytes::text`,
      );
      for (const run of discovery.rows) {
        await client.query(
          `INSERT INTO github_discovery_runs (
             id,state,query_set_sha256,policy_version,maximum_queries,maximum_pages,
             maximum_results,maximum_requests,maximum_response_bytes
           ) VALUES ($1,'queued',$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            run.query_set_sha256,
            run.policy_version,
            run.maximum_queries,
            run.maximum_pages,
            run.maximum_results,
            run.maximum_requests,
            run.maximum_response_bytes,
          ],
        );
      }
      return abandoned.rows.length + discovery.rows.length;
    });
  }
}

function cacheKeySha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
