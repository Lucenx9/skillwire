import { sha256Hex } from "../../domain/catalog/canonical-revision.js";
import type {
  GitHubSourceProvider,
  OperationContext,
} from "../ports/github-source-provider.js";
import type {
  DiscoveryRunBudgets,
  SourceDiscoveryStore,
} from "../ports/source-discovery-store.js";
import type { SyncLease } from "../ports/sync-lease-store.js";
import type { GitHubSearchDiscoveryProvider } from "../../ingestion/github/discovery-provider.js";
import type { ResolvedDiscoverySource } from "../ports/source-discovery-store.js";

export class SourceDiscoveryService {
  constructor(
    private readonly search: GitHubSearchDiscoveryProvider,
    private readonly repositories: GitHubSourceProvider,
    private readonly store: SourceDiscoveryStore,
    private readonly querySetIdentity: string,
    private readonly budgets: DiscoveryRunBudgets,
  ) {}

  enqueue(context?: OperationContext) {
    return this.store.enqueueDiscovery(
      sha256Hex(this.querySetIdentity),
      this.budgets,
      context,
    );
  }

  enqueueScheduled(cadenceMs: number, context?: OperationContext) {
    return this.store.enqueueScheduledDiscovery(
      sha256Hex(this.querySetIdentity),
      this.budgets,
      cadenceMs,
      context,
    );
  }

  async execute(
    runId: string,
    lease: SyncLease,
    context: OperationContext = {},
  ): Promise<void> {
    if (lease.key !== "discovery") throw new Error("LEASE_SCOPE_INVALID");
    await this.store.markDiscoveryRunning(runId, lease, context);
    try {
      const sharedBudget = context.budget ?? {
        requests: 0,
        retries: 0,
        responseBytes: 0,
        maximumRequests: this.budgets.maximumRequests,
        maximumRetries: 3,
        maximumResponseBytes: this.budgets.maximumResponseBytes,
      };
      const operation: OperationContext = {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(context.deadline === undefined
          ? {}
          : { deadline: context.deadline }),
        budget: sharedBudget,
      };
      const discovered = await this.search.discover(operation);
      const sources: ResolvedDiscoverySource[] = [];
      for (const hint of discovered.hints) {
        context.signal?.throwIfAborted();
        const repository = await this.repositories.resolvePublicRepository(
          hint,
          operation,
        );
        if (repository.repositoryId !== hint.repositoryId) {
          throw new Error("SOURCE_IDENTITY_MISMATCH");
        }
        sources.push({
          repository,
          evidence: discovered.evidence.filter(
            ({ repositoryId }) => repositoryId === hint.repositoryId,
          ),
        });
      }
      await this.store.completeDiscovery(
        runId,
        lease,
        {
          sources,
          incomplete: discovered.incomplete,
          counters: {
            ...discovered.counters,
            requests: sharedBudget.requests,
            retries: sharedBudget.retries,
            responseBytes: sharedBudget.responseBytes,
          },
        },
        context,
      );
    } catch (error) {
      const cancelled =
        context.signal?.aborted === true ||
        (error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError"));
      try {
        await this.store.failDiscovery(
          runId,
          lease,
          cancelled ? "CANCELLED" : safeDiscoveryFailure(error),
          cancelled,
          context.signal?.aborted === true ? {} : context,
        );
      } catch {
        // Lost leases and cancelled transactions intentionally cannot write terminal state.
      }
      throw error;
    }
  }
}

function safeDiscoveryFailure(error: unknown): string {
  if (!(error instanceof Error)) return "GITHUB_TRANSIENT";
  const allowed = new Set([
    "GITHUB_RATE_LIMITED",
    "GITHUB_TRANSIENT",
    "GITHUB_SCHEMA_INVALID",
    "PAGINATION_BUDGET_EXCEEDED",
    "PAGINATION_INVALID",
    "REQUEST_BUDGET_EXCEEDED",
    "RESULT_BUDGET_EXCEEDED",
    "RESPONSE_BUDGET_EXCEEDED",
    "CACHE_MISS_ON_NOT_MODIFIED",
    "SOURCE_IDENTITY_MISMATCH",
  ]);
  return allowed.has(error.message) ? error.message : "GITHUB_TRANSIENT";
}
