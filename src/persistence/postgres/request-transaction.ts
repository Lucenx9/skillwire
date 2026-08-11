import type { Pool, PoolClient } from "pg";

import {
  assertRequestActive,
  requestTimeRemaining,
  type RequestExecution,
} from "../../application/request-execution.js";

export async function requestTransaction<Result>(
  pool: Pool,
  execution: RequestExecution,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  assertRequestActive(execution);
  const client = await pool.connect();
  let began = false;
  try {
    assertRequestActive(execution);
    await client.query("BEGIN");
    began = true;
    assertRequestActive(execution);
    if (execution.deadline !== undefined) {
      const remaining = requestTimeRemaining(execution);
      assertRequestActive(execution);
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(Math.max(1, remaining)),
      ]);
    }
    const result = await operation(client);
    assertRequestActive(execution);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original cancellation or database failure remains authoritative.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
