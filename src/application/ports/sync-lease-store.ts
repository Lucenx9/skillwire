export interface SyncLease {
  readonly key: string;
  readonly holderId: string;
  readonly fencingToken: bigint;
  readonly expiresAt: Date;
}

export interface SyncLeaseStore {
  acquire(
    key: string,
    holderId: string,
    durationMs: number,
    context?: OperationContext,
  ): Promise<SyncLease | undefined>;
  renew(
    lease: SyncLease,
    durationMs: number,
    context?: OperationContext,
  ): Promise<SyncLease | undefined>;
  release(lease: SyncLease, context?: OperationContext): Promise<void>;
}
import type { OperationContext } from "./github-source-provider.js";
