import type { PoolClient } from "pg";

import type { SyncLease } from "../../application/ports/sync-lease-store.js";

export async function assertLeaseHeld(
  client: PoolClient,
  lease: SyncLease,
): Promise<void> {
  const result = await client.query(
    `
      SELECT 1
      FROM github_job_leases
      WHERE lease_key = $1 AND holder_id = $2 AND fencing_token = $3
        AND lease_expires_at > clock_timestamp()
      FOR UPDATE
    `,
    [lease.key, lease.holderId, lease.fencingToken.toString()],
  );
  if (result.rowCount !== 1) throw new Error("LEASE_LOST");
}
