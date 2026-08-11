import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Pool, PoolClient } from "pg";

import { readRequiredConfiguration } from "../../config.js";
import { createPostgresPool } from "./client.js";

const MIGRATION_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_ID = 1_938_117_405;

interface Migration {
  readonly version: string;
  readonly sql: string;
  readonly checksum: string;
}

async function loadMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory))
    .filter((name) => MIGRATION_PATTERN.test(name))
    .toSorted();
  const migrations = await Promise.all(
    names.map(async (name) => {
      const match = MIGRATION_PATTERN.exec(name);
      if (match === null) throw new Error("Invalid migration filename");
      const sql = await readFile(join(directory, name), "utf8");
      return {
        version: match[1] ?? "",
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  if (migrations.length === 0) throw new Error("No migrations found");
  return migrations;
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum character(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
    )
  `);
}

export async function runMigrations(
  pool: Pool,
  directory = join(process.cwd(), "migrations"),
): Promise<void> {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await ensureMigrationTable(client);
    for (const migration of migrations) {
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [migration.version],
      );
      const checksum = existing.rows[0]?.checksum;
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) {
          throw new Error(`Migration checksum drift: ${migration.version}`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    client.release();
  }
}

async function runFromCommandLine(): Promise<void> {
  const connectionString = readRequiredConfiguration(
    process.env,
    "DATABASE_URL",
  );
  const pool = createPostgresPool(connectionString);
  try {
    await runMigrations(pool);
    process.stdout.write("PostgreSQL migrations are current.\n");
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  runFromCommandLine().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Migration failed"}\n`,
    );
    process.exitCode = 1;
  });
}
