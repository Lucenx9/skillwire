import { randomBytes } from "node:crypto";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { runMigrations } from "../../src/persistence/postgres/migration-runner.js";

const POSTGRES_IMAGE = "postgres:17.10-alpine";

export interface TestDatabase {
  readonly connectionString: string;
  readonly pool: Pool;
  migrate(): Promise<void>;
  simulateOutage(): Promise<void>;
  recover(): Promise<void>;
  close(): Promise<void>;
}

function testDatabaseName(): string {
  return `skillwire_test_${randomBytes(8).toString("hex")}`;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const container =
    process.env["TEST_DATABASE_URL"] === undefined
      ? await new PostgreSqlContainer(POSTGRES_IMAGE).start()
      : undefined;
  const configuredUrl =
    process.env["TEST_DATABASE_URL"] ?? container?.getConnectionUri();
  if (configuredUrl === undefined) throw new Error("Database URL unavailable");

  const databaseName = testDatabaseName();
  const adminPool = new Pool({ connectionString: configuredUrl, max: 1 });
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  const databaseUrl = new URL(configuredUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const connectionString = databaseUrl.toString();
  const pool = new Pool({ connectionString, max: 8 });
  pool.on("error", () => {
    // Outage tests deliberately terminate idle backend connections.
  });
  let outage = false;

  return {
    connectionString,
    pool,
    migrate: () => runMigrations(pool),
    simulateOutage: async () => {
      if (outage) return;
      await adminPool.query(
        `ALTER DATABASE "${databaseName}" WITH ALLOW_CONNECTIONS false`,
      );
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
        [databaseName],
      );
      outage = true;
    },
    recover: async () => {
      if (!outage) return;
      await adminPool.query(
        `ALTER DATABASE "${databaseName}" WITH ALLOW_CONNECTIONS true`,
      );
      outage = false;
    },
    close: async () => {
      if (outage) {
        await adminPool.query(
          `ALTER DATABASE "${databaseName}" WITH ALLOW_CONNECTIONS true`,
        );
      }
      await pool.end();
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE "${databaseName}"`);
      await adminPool.end();
      await container?.stop();
    },
  };
}
