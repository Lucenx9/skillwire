import { randomBytes } from "node:crypto";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { runMigrations } from "../../src/persistence/postgres/migration-runner.js";

const POSTGRES_IMAGE = "postgres:17.10-alpine";

export interface TestDatabase {
  readonly connectionString: string;
  readonly pool: Pool;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

function testDatabaseName(): string {
  return `skillwire_test_${randomBytes(8).toString("hex")}`;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const configuredUrl = process.env["TEST_DATABASE_URL"];
  if (configuredUrl === undefined) {
    const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    const connectionString = container.getConnectionUri();
    const pool = new Pool({ connectionString, max: 8 });
    return {
      connectionString,
      pool,
      migrate: () => runMigrations(pool),
      close: async () => {
        await pool.end();
        await container.stop();
      },
    };
  }

  const databaseName = testDatabaseName();
  const adminPool = new Pool({ connectionString: configuredUrl, max: 1 });
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  const databaseUrl = new URL(configuredUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const connectionString = databaseUrl.toString();
  const pool = new Pool({ connectionString, max: 8 });

  return {
    connectionString,
    pool,
    migrate: () => runMigrations(pool),
    close: async () => {
      await pool.end();
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE "${databaseName}"`);
      await adminPool.end();
    },
  };
}
