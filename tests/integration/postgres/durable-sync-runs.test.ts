import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresGitHubSourceStore } from "../../../src/persistence/postgres/github-source-store.js";
import { PostgresSyncLeaseStore } from "../../../src/persistence/postgres/sync-lease-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

describe("durable GitHub synchronization runs", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
  }, 120_000);

  afterAll(async () => database.close());

  it("deduplicates active work and durably records success, retry, recovery, cancellation, and quarantine", async () => {
    const store = new PostgresGitHubSourceStore(database.pool);
    const leases = new PostgresSyncLeaseStore(database.pool);
    const source = await store.registerSource(
      {
        repositoryId: 991_001,
        owner: "fixture-owner",
        repository: "durable-runs",
        defaultBranch: "main",
      },
      "fixture-admin",
    );

    const queued = await store.enqueueSync(source.sourceId, "administrator");
    await expect(
      store.enqueueSync(source.sourceId, "scheduled"),
    ).resolves.toMatchObject({ runId: queued.runId, created: false });
    expect(await store.claimQueuedSyncRuns(10)).toEqual([
      expect.objectContaining({
        runId: queued.runId,
        attemptCount: 0,
        state: "queued",
      }),
    ]);

    const firstLease = await leases.acquire(
      `sync/${source.sourceId}`,
      randomUUID(),
      10_000,
    );
    if (firstLease === undefined) throw new Error("fixture lease missing");
    await store.markSyncRunning(queued.runId, firstLease);
    await store.completeSyncRun(queued.runId, firstLease, {
      commitSha: "1".repeat(40),
      treeSha: "2".repeat(40),
      candidates: 2,
      published: 1,
      reused: 1,
      quarantined: 0,
      resources: 3,
      requests: 5,
      retries: 0,
      responseBytes: 1024,
    });
    await leases.release(firstLease);

    const failed = await store.enqueueSync(source.sourceId, "scheduled");
    const failedLease = await leases.acquire(
      `sync/${source.sourceId}`,
      randomUUID(),
      10_000,
    );
    if (failedLease === undefined) throw new Error("fixture lease missing");
    await store.markSyncRunning(failed.runId, failedLease);
    await store.failSyncRun(failed.runId, failedLease, "GITHUB_RATE_LIMITED", {
      cancelled: false,
      retryable: true,
      retryAfterMilliseconds: 60_000,
    });
    await leases.release(failedLease);
    const retry = await database.pool.query<{
      id: string;
      attempt_count: number;
      previous_run_id: string;
      delay_seconds: number;
    }>(
      `SELECT id,attempt_count,previous_run_id,
              extract(epoch FROM next_attempt_at-queued_at)::float8 AS delay_seconds
       FROM github_sync_runs WHERE state='queued' AND source_id=$1`,
      [source.sourceId],
    );
    expect(retry.rows).toHaveLength(1);
    expect(retry.rows[0]).toMatchObject({
      attempt_count: 1,
      previous_run_id: failed.runId,
    });
    expect(retry.rows[0]?.delay_seconds).toBeGreaterThan(59);

    await database.pool.query(
      "UPDATE github_sync_runs SET next_attempt_at=clock_timestamp() WHERE id=$1",
      [retry.rows[0]?.id],
    );
    const retryRun = (await store.claimQueuedSyncRuns(1))[0];
    if (retryRun === undefined) throw new Error("retry run missing");
    expect(retryRun.attemptCount).toBe(1);
    const abandonedLease = await leases.acquire(
      `sync/${source.sourceId}`,
      randomUUID(),
      10_000,
    );
    if (abandonedLease === undefined) throw new Error("fixture lease missing");
    await store.markSyncRunning(retryRun.runId, abandonedLease);
    await leases.release(abandonedLease);
    await expect(store.recoverAbandonedJobs()).resolves.toBe(1);

    const recovered = await database.pool.query<{
      id: string;
      attempt_count: number;
      previous_run_id: string;
    }>(
      `SELECT id,attempt_count,previous_run_id FROM github_sync_runs
       WHERE state='queued' AND source_id=$1`,
      [source.sourceId],
    );
    expect(recovered.rows[0]).toMatchObject({
      attempt_count: 2,
      previous_run_id: retryRun.runId,
    });

    await database.pool.query(
      "UPDATE github_sync_runs SET next_attempt_at=clock_timestamp() WHERE id=$1",
      [recovered.rows[0]?.id],
    );
    const cancelledRun = (await store.claimQueuedSyncRuns(1))[0];
    if (cancelledRun === undefined) throw new Error("recovered run missing");
    const cancelledLease = await leases.acquire(
      `sync/${source.sourceId}`,
      randomUUID(),
      10_000,
    );
    if (cancelledLease === undefined) throw new Error("fixture lease missing");
    await store.markSyncRunning(cancelledRun.runId, cancelledLease);
    await store.failSyncRun(cancelledRun.runId, cancelledLease, "CANCELLED", {
      cancelled: true,
      retryable: false,
    });
    await leases.release(cancelledLease);

    const quarantined = await store.enqueueSync(
      source.sourceId,
      "administrator",
    );
    const quarantineLease = await leases.acquire(
      `sync/${source.sourceId}`,
      randomUUID(),
      10_000,
    );
    if (quarantineLease === undefined) throw new Error("fixture lease missing");
    await store.markSyncRunning(quarantined.runId, quarantineLease);
    await store.quarantineSyncRun(
      quarantined.runId,
      quarantineLease,
      "TREE_AMBIGUOUS",
    );
    await leases.release(quarantineLease);

    const states = await database.pool.query<{
      state: string;
      terminal_code: string | null;
    }>(
      `SELECT state,terminal_code FROM github_sync_runs
       WHERE source_id=$1 ORDER BY queued_at,id`,
      [source.sourceId],
    );
    expect(states.rows.map(({ state }) => state)).toEqual([
      "succeeded",
      "failed",
      "failed",
      "cancelled",
      "quarantined",
    ]);
    expect(states.rows.map(({ terminal_code }) => terminal_code)).toEqual([
      null,
      "GITHUB_RATE_LIMITED",
      "RUN_ABANDONED",
      "CANCELLED",
      "TREE_AMBIGUOUS",
    ]);
    const quarantineResults = await database.pool.query<{
      reason_code: string;
      evidence_sha256: string;
    }>(
      "SELECT reason_code,evidence_sha256 FROM github_sync_candidate_results WHERE sync_run_id=$1",
      [quarantined.runId],
    );
    expect(quarantineResults.rows).toHaveLength(1);
    expect(quarantineResults.rows[0]?.reason_code).toBe("TREE_AMBIGUOUS");
    expect(quarantineResults.rows[0]?.evidence_sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );

    const discovery = await store.enqueueDiscovery("d".repeat(64), {
      maximumQueries: 2,
      maximumPages: 4,
      maximumResults: 50,
      maximumRequests: 20,
      maximumResponseBytes: 1024,
    });
    const discoveryLease = await leases.acquire(
      "discovery",
      randomUUID(),
      10_000,
    );
    if (discoveryLease === undefined)
      throw new Error("discovery lease missing");
    await store.markDiscoveryRunning(discovery.runId, discoveryLease);
    await leases.release(discoveryLease);
    await expect(store.recoverAbandonedJobs()).resolves.toBe(1);
    const discoveryStates = await database.pool.query<{ state: string }>(
      "SELECT state FROM github_discovery_runs ORDER BY queued_at,id",
    );
    expect(discoveryStates.rows.map(({ state }) => state)).toEqual([
      "failed",
      "queued",
    ]);
  }, 120_000);
});
