import type { Pool } from "pg";

import type { OperationContext } from "../../application/ports/github-source-provider.js";
import type {
  SyncLease,
  SyncLeaseStore,
} from "../../application/ports/sync-lease-store.js";
import { requestTransaction } from "./request-transaction.js";

interface LeaseRow {
  readonly lease_key: string;
  readonly holder_id: string;
  readonly fencing_token: string;
  readonly lease_expires_at: Date;
}

function validateLeaseInput(
  key: string,
  holderId: string,
  durationMs: number,
): void {
  if (
    !(
      key === "discovery" ||
      /^sync\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        key,
      )
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      holderId,
    ) ||
    !Number.isInteger(durationMs) ||
    durationMs < 100 ||
    durationMs > 3_600_000
  ) {
    throw new Error("INVALID_LEASE_INPUT");
  }
}

function toLease(row: LeaseRow): SyncLease {
  return {
    key: row.lease_key,
    holderId: row.holder_id,
    fencingToken: BigInt(row.fencing_token),
    expiresAt: row.lease_expires_at,
  };
}

export class PostgresSyncLeaseStore implements SyncLeaseStore {
  constructor(private readonly pool: Pool) {}

  acquire(
    key: string,
    holderId: string,
    durationMs: number,
    context: OperationContext = {},
  ): Promise<SyncLease | undefined> {
    validateLeaseInput(key, holderId, durationMs);
    return requestTransaction(this.pool, context, async (client) => {
      const result = await client.query<LeaseRow>(
        `
          INSERT INTO github_job_leases (
            lease_key, holder_id, fencing_token, acquired_at, renewed_at, lease_expires_at
          ) VALUES (
            $1, $2, 1, clock_timestamp(), clock_timestamp(),
            clock_timestamp() + $3 * interval '1 millisecond'
          )
          ON CONFLICT (lease_key) DO UPDATE SET
            holder_id = EXCLUDED.holder_id,
            fencing_token = github_job_leases.fencing_token + 1,
            acquired_at = clock_timestamp(),
            renewed_at = clock_timestamp(),
            lease_expires_at = clock_timestamp() + $3 * interval '1 millisecond'
          WHERE github_job_leases.lease_expires_at <= clock_timestamp()
          RETURNING lease_key, holder_id, fencing_token, lease_expires_at
        `,
        [key, holderId, durationMs],
      );
      return result.rows[0] === undefined ? undefined : toLease(result.rows[0]);
    });
  }

  renew(
    lease: SyncLease,
    durationMs: number,
    context: OperationContext = {},
  ): Promise<SyncLease | undefined> {
    validateLeaseInput(lease.key, lease.holderId, durationMs);
    return requestTransaction(this.pool, context, async (client) => {
      const result = await client.query<LeaseRow>(
        `
          UPDATE github_job_leases SET
            renewed_at = clock_timestamp(),
            lease_expires_at = clock_timestamp() + $4 * interval '1 millisecond'
          WHERE lease_key = $1 AND holder_id = $2 AND fencing_token = $3
            AND lease_expires_at > clock_timestamp()
          RETURNING lease_key, holder_id, fencing_token, lease_expires_at
        `,
        [lease.key, lease.holderId, lease.fencingToken.toString(), durationMs],
      );
      return result.rows[0] === undefined ? undefined : toLease(result.rows[0]);
    });
  }

  release(lease: SyncLease, context: OperationContext = {}): Promise<void> {
    return requestTransaction(this.pool, context, async (client) => {
      await client.query(
        `
          UPDATE github_job_leases SET
            renewed_at = clock_timestamp() - interval '1 millisecond',
            lease_expires_at = clock_timestamp()
          WHERE lease_key = $1 AND holder_id = $2 AND fencing_token = $3
        `,
        [lease.key, lease.holderId, lease.fencingToken.toString()],
      );
    });
  }
}
