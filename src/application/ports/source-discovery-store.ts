import type {
  GitHubDiscoveryEvidence,
  GitHubRepositoryIdentity,
} from "../../domain/external-catalog/types.js";
import type { DiscoveryPageCache } from "../../ingestion/github/discovery-provider.js";
import type { OperationContext } from "./github-source-provider.js";
import type { SyncLease } from "./sync-lease-store.js";

export interface DiscoveryRunBudgets {
  readonly maximumQueries: number;
  readonly maximumPages: number;
  readonly maximumResults: number;
  readonly maximumRequests: number;
  readonly maximumResponseBytes: number;
}

export interface QueuedDiscoveryRun {
  readonly runId: string;
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly created: boolean;
}

export interface ResolvedDiscoverySource {
  readonly repository: GitHubRepositoryIdentity;
  readonly evidence: readonly GitHubDiscoveryEvidence[];
}

export interface DiscoveryCompletion {
  readonly sources: readonly ResolvedDiscoverySource[];
  readonly incomplete: boolean;
  readonly counters: {
    readonly queries: number;
    readonly pages: number;
    readonly results: number;
    readonly uniqueRepositories: number;
    readonly requests: number;
    readonly retries: number;
    readonly responseBytes: number;
  };
}

export interface SourceDiscoveryStore extends DiscoveryPageCache {
  enqueueDiscovery(
    querySetSha256: string,
    budgets: DiscoveryRunBudgets,
    context?: OperationContext,
  ): Promise<QueuedDiscoveryRun>;
  enqueueScheduledDiscovery(
    querySetSha256: string,
    budgets: DiscoveryRunBudgets,
    cadenceMs: number,
    context?: OperationContext,
  ): Promise<QueuedDiscoveryRun>;
  markDiscoveryRunning(
    runId: string,
    lease: SyncLease,
    context?: OperationContext,
  ): Promise<void>;
  completeDiscovery(
    runId: string,
    lease: SyncLease,
    completion: DiscoveryCompletion,
    context?: OperationContext,
  ): Promise<void>;
  failDiscovery(
    runId: string,
    lease: SyncLease,
    code: string,
    cancelled: boolean,
    context?: OperationContext,
  ): Promise<void>;
  claimQueuedDiscovery(context?: OperationContext): Promise<string | undefined>;
}
