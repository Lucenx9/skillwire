import { randomUUID } from "node:crypto";

import type { OperationContext } from "../application/ports/github-source-provider.js";
import type {
  SyncLease,
  SyncLeaseStore,
} from "../application/ports/sync-lease-store.js";
import type {
  ClaimedSyncRun,
  SyncRunStore,
} from "../application/ports/sync-run-store.js";
import type { PublishedExternalSnapshot } from "../application/ports/external-catalog-store.js";

export type ScheduledSourceStore = SyncRunStore;

export interface ScheduledDiscoveryStore {
  claimQueuedDiscovery(context?: OperationContext): Promise<string | undefined>;
}

export interface ScheduledDiscovery {
  enqueueScheduled(
    cadenceMs: number,
    context?: OperationContext,
  ): Promise<unknown>;
  execute(
    runId: string,
    lease: SyncLease,
    context?: OperationContext,
  ): Promise<void>;
}

export interface ScheduledSourceSynchronizer {
  syncScheduled(
    sourceId: string,
    lease: SyncLease,
    context?: OperationContext,
    requestedCommitSha?: string,
    requestedRepository?: ClaimedSyncRun["requestedRepository"],
    requestedCandidateId?: string,
  ): Promise<PublishedExternalSnapshot>;
}

export interface GitHubSyncSchedulerOptions {
  readonly leaseDurationMs: number;
  readonly sourceCadenceMs: number;
  readonly discoveryCadenceMs: number;
  readonly maximumSourcesPerTick: number;
  readonly operationTimeoutMs: number;
  readonly maximumAttempts: number;
  readonly maximumConcurrentJobs: number;
}

export class GitHubSyncScheduler {
  readonly #shutdown = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #active = new Set<Promise<void>>();

  constructor(
    private readonly leases: SyncLeaseStore,
    private readonly discoveryStore: ScheduledDiscoveryStore,
    private readonly discovery: ScheduledDiscovery,
    private readonly sources: ScheduledSourceStore,
    private readonly synchronization: ScheduledSourceSynchronizer,
    private readonly options: GitHubSyncSchedulerOptions,
  ) {
    if (
      options.leaseDurationMs < 1000 ||
      options.sourceCadenceMs < 60_000 ||
      options.discoveryCadenceMs < 60_000 ||
      options.maximumSourcesPerTick < 1 ||
      options.maximumSourcesPerTick > 100 ||
      options.operationTimeoutMs < 1_000 ||
      options.operationTimeoutMs > 900_000 ||
      options.maximumAttempts < 1 ||
      options.maximumAttempts > 10 ||
      options.maximumConcurrentJobs < 1 ||
      options.maximumConcurrentJobs > 32
    ) {
      throw new Error("INVALID_SCHEDULER_CONFIGURATION");
    }
  }

  start(intervalMs: number): void {
    if (this.#timer !== undefined || intervalMs < 1000) {
      throw new Error("SCHEDULER_ALREADY_STARTED");
    }
    this.#timer = setInterval(() => {
      const operation = this.runOnce({ signal: this.#shutdown.signal });
      this.#active.add(operation);
      void operation
        .catch(() => undefined)
        .finally(() => this.#active.delete(operation));
    }, intervalMs);
    this.#timer.unref();
  }

  async runOnce(context: OperationContext = {}): Promise<void> {
    const baseSignal = combineSignals(context.signal, this.#shutdown.signal);
    const deadline = Math.min(
      context.deadline ?? Number.POSITIVE_INFINITY,
      Date.now() + this.options.operationTimeoutMs,
    );
    const signal = combineSignals(
      baseSignal,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    );
    const operation: OperationContext = {
      signal,
      deadline,
      ...(context.budget === undefined ? {} : { budget: context.budget }),
    };
    signal.throwIfAborted();
    await this.sources.recoverAbandonedJobs(operation);
    await this.discovery.enqueueScheduled(
      this.options.discoveryCadenceMs,
      operation,
    );
    const discoveryRunId =
      await this.discoveryStore.claimQueuedDiscovery(operation);
    if (discoveryRunId !== undefined) {
      await this.#withLease("discovery", operation, (lease, jobContext) =>
        this.discovery.execute(discoveryRunId, lease, jobContext),
      );
    }
    await this.sources.enqueueDueSourceSyncs(
      this.options.maximumSourcesPerTick,
      operation,
    );
    const runs = await this.sources.claimQueuedSyncRuns(
      Math.min(
        this.options.maximumSourcesPerTick,
        this.options.maximumConcurrentJobs,
      ),
      operation,
    );
    const outcomes = await Promise.allSettled(
      runs.map((run) => this.#executeSyncRun(run, operation)),
    );
    const failed = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    if (failed !== undefined) throw failed.reason;
  }

  async #executeSyncRun(
    run: ClaimedSyncRun,
    operation: OperationContext,
  ): Promise<void> {
    operation.signal?.throwIfAborted();
    await this.#withLease(
      `sync/${run.sourceId}`,
      operation,
      async (lease, jobContext) => {
        await this.sources.markSyncRunning(run.runId, lease, jobContext);
        try {
          const result = await this.synchronization.syncScheduled(
            run.sourceId,
            lease,
            jobContext,
            run.requestedCommitSha,
            run.requestedRepository,
            run.requestedCandidateId,
          );
          const budget = jobContext.budget;
          await this.sources.completeSyncRun(
            run.runId,
            lease,
            {
              commitSha: result.commitSha,
              treeSha: result.treeSha,
              candidates: result.candidateTraces.length,
              published: result.traces.filter(
                ({ result: state }) => state === "published",
              ).length,
              reused: result.traces.filter(
                ({ result: state }) => state === "reused",
              ).length,
              quarantined: result.candidateTraces.filter(
                ({ classification }) => classification === "quarantined",
              ).length,
              resources: result.resourceCount,
              requests: budget?.requests ?? 0,
              retries: budget?.retries ?? 0,
              responseBytes: budget?.responseBytes ?? 0,
            },
            jobContext,
          );
        } catch (error) {
          const code = syncFailureCode(error);
          const cancelled =
            jobContext.signal?.aborted === true || code === "CANCELLED";
          const retryable =
            !cancelled &&
            run.attemptCount + 1 < this.options.maximumAttempts &&
            [
              "GITHUB_TRANSIENT",
              "GITHUB_RATE_LIMITED",
              "RESPONSE_BUDGET_EXCEEDED",
              "REQUEST_BUDGET_EXCEEDED",
              "DEADLINE_EXCEEDED",
            ].includes(code);
          const retryAfterMilliseconds =
            error instanceof Error &&
            "retryAfterMilliseconds" in error &&
            typeof error.retryAfterMilliseconds === "number"
              ? error.retryAfterMilliseconds
              : undefined;
          const retryDelayValid =
            retryAfterMilliseconds === undefined ||
            (Number.isFinite(retryAfterMilliseconds) &&
              retryAfterMilliseconds >= 0 &&
              retryAfterMilliseconds <= 604_800_000);
          if (isDeterministicQuarantine(code)) {
            await this.sources.quarantineSyncRun(
              run.runId,
              lease,
              code,
              jobContext,
            );
            return;
          }
          await this.sources
            .failSyncRun(
              run.runId,
              lease,
              code,
              {
                cancelled,
                retryable: retryable && retryDelayValid,
                ...(retryAfterMilliseconds === undefined
                  ? {}
                  : { retryAfterMilliseconds }),
              },
              jobContext,
            )
            .catch(() => undefined);
          if (!retryable && !cancelled) throw error;
        }
      },
    );
  }

  async #withLease(
    key: string,
    context: OperationContext,
    operation: (lease: SyncLease, context: OperationContext) => Promise<void>,
  ): Promise<boolean> {
    const lease = await this.leases.acquire(
      key,
      randomUUID(),
      this.options.leaseDurationMs,
      context,
    );
    if (lease === undefined) return false;
    const leaseLost = new AbortController();
    const jobSignal = combineSignals(context.signal, leaseLost.signal);
    const jobContext: OperationContext = {
      signal: jobSignal,
      ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
      ...(context.budget === undefined ? {} : { budget: context.budget }),
    };
    let renewing = false;
    const heartbeat = setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        void this.leases
          .renew(lease, this.options.leaseDurationMs, jobContext)
          .then((renewed) => {
            if (renewed === undefined) {
              leaseLost.abort(new DOMException("lease lost", "AbortError"));
            }
          })
          .catch(() => {
            leaseLost.abort(new DOMException("lease lost", "AbortError"));
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(100, Math.floor(this.options.leaseDurationMs / 3)),
    );
    heartbeat.unref();
    try {
      await operation(lease, jobContext);
      jobSignal.throwIfAborted();
      return true;
    } finally {
      clearInterval(heartbeat);
      await this.leases.release(lease, {}).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.#shutdown.abort(new DOMException("scheduler shutdown", "AbortError"));
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.allSettled([...this.#active]);
  }
}

function syncFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "INTERNAL";
  if (error.name === "AbortError") return "CANCELLED";
  if (error.name === "TimeoutError") return "DEADLINE_EXCEEDED";
  return /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message)
    ? error.message
    : "INTERNAL";
}

function isDeterministicQuarantine(code: string): boolean {
  return new Set([
    "MANIFEST_INVALID",
    "MANIFEST_OVERSIZED",
    "MANIFEST_DUPLICATE_SKILL",
    "SKILL_SCHEMA_INVALID",
    "TREE_TRUNCATED",
    "TREE_OVERSIZED",
    "TREE_AMBIGUOUS",
    "OBJECT_UNSUPPORTED",
    "PATH_UNSAFE",
    "RESOURCE_MISSING",
    "RESOURCE_NON_TEXT",
    "RESOURCE_OVERSIZED",
    "LICENSE_MISSING",
    "LICENSE_UNSUPPORTED",
    "LICENSE_CONFLICT",
    "ATTRIBUTION_MISSING",
    "DEPENDENCY_MISSING",
    "DEPENDENCY_AMBIGUOUS",
    "DEPENDENCY_CYCLE",
    "HASH_MISMATCH",
    "GITHUB_SCHEMA_INVALID",
  ]).has(code);
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal,
): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second]);
}
