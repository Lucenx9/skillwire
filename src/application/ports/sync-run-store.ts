import type { OperationContext } from "./github-source-provider.js";
import type { SyncLease } from "./sync-lease-store.js";

export type DurableSyncRunState =
  "queued" | "running" | "succeeded" | "failed" | "cancelled" | "quarantined";

export type DurableSyncTrigger =
  "registration" | "administrator" | "scheduled" | "discovery";

export interface QueuedSyncRun {
  readonly runId: string;
  readonly sourceId: string;
  readonly state: DurableSyncRunState;
  readonly created: boolean;
  readonly attemptCount: number;
  readonly requestedCandidateId?: string | undefined;
  readonly requestedCommitSha?: string | undefined;
  readonly requestedRepository?:
    | {
        readonly repositoryId: number;
        readonly owner: string;
        readonly repository: string;
      }
    | undefined;
}

export interface ClaimedSyncRun extends QueuedSyncRun {
  readonly state: "queued";
}

export interface SyncRunSummary {
  readonly commitSha?: string | undefined;
  readonly treeSha?: string | undefined;
  readonly candidates: number;
  readonly published: number;
  readonly reused: number;
  readonly quarantined: number;
  readonly resources: number;
  readonly requests: number;
  readonly retries: number;
  readonly responseBytes: number;
}

export interface SyncRunStore {
  enqueueSync(
    sourceId: string,
    trigger: DurableSyncTrigger,
    context?: OperationContext,
  ): Promise<QueuedSyncRun>;
  enqueueCandidateVerification(
    candidateId: string,
    context?: OperationContext,
  ): Promise<QueuedSyncRun>;
  enqueueDueSourceSyncs(
    limit: number,
    context?: OperationContext,
  ): Promise<number>;
  claimQueuedSyncRuns(
    limit: number,
    context?: OperationContext,
  ): Promise<readonly ClaimedSyncRun[]>;
  markSyncRunning(
    runId: string,
    lease: SyncLease,
    context?: OperationContext,
  ): Promise<void>;
  completeSyncRun(
    runId: string,
    lease: SyncLease,
    summary: SyncRunSummary,
    context?: OperationContext,
  ): Promise<void>;
  failSyncRun(
    runId: string,
    lease: SyncLease,
    code: string,
    options: {
      readonly cancelled: boolean;
      readonly retryable: boolean;
      readonly retryAfterMilliseconds?: number | undefined;
    },
    context?: OperationContext,
  ): Promise<void>;
  quarantineSyncRun(
    runId: string,
    lease: SyncLease,
    reasonCode: string,
    context?: OperationContext,
  ): Promise<void>;
  recoverAbandonedJobs(context?: OperationContext): Promise<number>;
}
