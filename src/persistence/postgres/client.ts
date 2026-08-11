import { Pool } from "pg";

export function createPostgresPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", () => {
    // Active readiness probes expose database loss; idle-client errors must not
    // become unhandled EventEmitter failures that terminate the process.
  });
  return pool;
}
