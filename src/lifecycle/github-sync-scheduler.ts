import { randomUUID } from "node:crypto";

import type { OperationContext } from "../application/ports/github-source-provider.js";
import type {
  SyncLease,
  SyncLeaseStore,
} from "../application/ports/sync-lease-store.js";

export interface ScheduledSourceStore {
  listDueSourceIds(
    limit: number,
    context?: OperationContext,
  ): Promise<readonly string[]>;
  scheduleNextSource(
    sourceId: string,
    delayMs: number,
    context?: OperationContext,
  ): Promise<void>;
}

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
  ): Promise<void>;
}

export interface GitHubSyncSchedulerOptions {
  readonly leaseDurationMs: number;
  readonly sourceCadenceMs: number;
  readonly discoveryCadenceMs: number;
  readonly maximumSourcesPerTick: number;
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
      options.maximumSourcesPerTick > 100
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
      void operation.finally(() => this.#active.delete(operation));
    }, intervalMs);
    this.#timer.unref();
  }

  async runOnce(context: OperationContext = {}): Promise<void> {
    const signal = combineSignals(context.signal, this.#shutdown.signal);
    const operation: OperationContext = {
      signal,
      ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
      ...(context.budget === undefined ? {} : { budget: context.budget }),
    };
    signal.throwIfAborted();
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
    const dueSources = await this.sources.listDueSourceIds(
      this.options.maximumSourcesPerTick,
      operation,
    );
    for (const sourceId of dueSources) {
      signal.throwIfAborted();
      const completed = await this.#withLease(
        `sync/${sourceId}`,
        operation,
        (lease, jobContext) =>
          this.synchronization.syncScheduled(sourceId, lease, jobContext),
      );
      if (completed) {
        await this.sources.scheduleNextSource(
          sourceId,
          this.options.sourceCadenceMs,
          operation,
        );
      }
    }
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

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal,
): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second]);
}
