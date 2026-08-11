import { describe, expect, it } from "vitest";

import type { SyncLeaseStore } from "../../../src/application/ports/sync-lease-store.js";
import { GitHubSyncScheduler } from "../../../src/lifecycle/github-sync-scheduler.js";

describe("GitHub synchronization scheduler", () => {
  it("claims discovery and due source work only while holding scoped leases", async () => {
    const events: string[] = [];
    const leases: SyncLeaseStore = {
      acquire(key, holderId) {
        events.push(`acquire:${key}`);
        return Promise.resolve({
          key,
          holderId,
          fencingToken: 1n,
          expiresAt: new Date(Date.now() + 60_000),
        });
      },
      renew() {
        throw new Error("unused");
      },
      release(lease) {
        events.push(`release:${lease.key}`);
        return Promise.resolve();
      },
    };
    const scheduler = new GitHubSyncScheduler(
      leases,
      { claimQueuedDiscovery: () => Promise.resolve("run-1") },
      {
        enqueueScheduled() {
          events.push("enqueue:discovery");
          return Promise.resolve(undefined);
        },
        execute(_runId, lease) {
          events.push(`discover:${lease.key}`);
          return Promise.resolve();
        },
      },
      {
        recoverAbandonedJobs: () => Promise.resolve(0),
        enqueueSync: () => Promise.reject(new Error("unused")),
        enqueueCandidateVerification: () => Promise.reject(new Error("unused")),
        enqueueDueSourceSyncs: () => Promise.resolve(1),
        claimQueuedSyncRuns: () =>
          Promise.resolve([
            {
              runId: "660e8400-e29b-41d4-a716-446655440000",
              sourceId: "550e8400-e29b-41d4-a716-446655440000",
              state: "queued" as const,
              created: false,
              attemptCount: 0,
            },
          ]),
        markSyncRunning(runId) {
          events.push(`running:${runId}`);
          return Promise.resolve();
        },
        completeSyncRun(runId) {
          events.push(`completed:${runId}`);
          return Promise.resolve();
        },
        failSyncRun: () => Promise.reject(new Error("unused")),
        quarantineSyncRun: () => Promise.reject(new Error("unused")),
      },
      {
        syncScheduled(_sourceId, lease) {
          events.push(`sync:${lease.key}`);
          return Promise.resolve({
            snapshotId: "770e8400-e29b-41d4-a716-446655440000",
            sourceId: "550e8400-e29b-41d4-a716-446655440000",
            commitSha: "a".repeat(40),
            treeSha: "b".repeat(40),
            resourceCount: 0,
            traces: [],
            candidateTraces: [],
            created: true,
          });
        },
      },
      {
        leaseDurationMs: 60_000,
        sourceCadenceMs: 3_600_000,
        discoveryCadenceMs: 3_600_000,
        maximumSourcesPerTick: 2,
        operationTimeoutMs: 300_000,
        maximumAttempts: 3,
        maximumConcurrentJobs: 2,
      },
    );
    await scheduler.runOnce();
    expect(events).toEqual([
      "enqueue:discovery",
      "acquire:discovery",
      "discover:discovery",
      "release:discovery",
      "acquire:sync/550e8400-e29b-41d4-a716-446655440000",
      "running:660e8400-e29b-41d4-a716-446655440000",
      "sync:sync/550e8400-e29b-41d4-a716-446655440000",
      "completed:660e8400-e29b-41d4-a716-446655440000",
      "release:sync/550e8400-e29b-41d4-a716-446655440000",
    ]);
    await scheduler.stop();
  });
});
