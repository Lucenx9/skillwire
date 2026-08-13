import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Pool, PoolClient } from "pg";

import { readRequiredConfiguration } from "../../config.js";
import { createPostgresPool } from "./client.js";

const MIGRATION_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_ID = 1_938_117_405;
const DEFAULT_LOCK_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MILLISECONDS = 300_000;
const MAX_LOCK_TIMEOUT_MILLISECONDS = 120_000;
const MAX_STATEMENT_TIMEOUT_MILLISECONDS = 3_600_000;

interface Migration {
  readonly version: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationExecutionOptions {
  readonly lockTimeoutMilliseconds?: number | undefined;
  readonly statementTimeoutMilliseconds?: number | undefined;
}

interface ResolvedMigrationExecutionOptions {
  readonly lockTimeoutMilliseconds: number;
  readonly statementTimeoutMilliseconds: number;
}

function boundedTimeout(
  name: string,
  explicitValue: number | undefined,
  environmentValue: string | undefined,
  defaultValue: number,
  maximum: number,
): number {
  const value =
    explicitValue ??
    (environmentValue === undefined ? defaultValue : Number(environmentValue));
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive bounded integer`);
  }
  return value;
}

function migrationExecutionOptions(
  options: MigrationExecutionOptions,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedMigrationExecutionOptions {
  return {
    lockTimeoutMilliseconds: boundedTimeout(
      "SKILLWIRE_MIGRATION_LOCK_TIMEOUT_MS",
      options.lockTimeoutMilliseconds,
      environment["SKILLWIRE_MIGRATION_LOCK_TIMEOUT_MS"],
      DEFAULT_LOCK_TIMEOUT_MILLISECONDS,
      MAX_LOCK_TIMEOUT_MILLISECONDS,
    ),
    statementTimeoutMilliseconds: boundedTimeout(
      "SKILLWIRE_MIGRATION_STATEMENT_TIMEOUT_MS",
      options.statementTimeoutMilliseconds,
      environment["SKILLWIRE_MIGRATION_STATEMENT_TIMEOUT_MS"],
      DEFAULT_STATEMENT_TIMEOUT_MILLISECONDS,
      MAX_STATEMENT_TIMEOUT_MILLISECONDS,
    ),
  };
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
  options: MigrationExecutionOptions = {},
): Promise<void> {
  const migrations = await loadMigrations(directory);
  const execution = migrationExecutionOptions(options);
  const latestKnownVersion = migrations.at(-1)?.version;
  if (latestKnownVersion === undefined) throw new Error("No migrations found");
  const client = await pool.connect();
  let advisoryLockHeld = false;
  let operationError: unknown;
  let operationFailed = false;
  try {
    await client.query(
      `SELECT
         set_config('lock_timeout',$1,false),
         set_config('statement_timeout',$2,false)`,
      [
        `${String(execution.lockTimeoutMilliseconds)}ms`,
        `${String(execution.statementTimeoutMilliseconds)}ms`,
      ],
    );
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    advisoryLockHeld = true;
    await ensureMigrationTable(client);
    const newer = await client.query<{ version: string }>(
      `SELECT version FROM schema_migrations
       WHERE version > $1 ORDER BY version LIMIT 1`,
      [latestKnownVersion],
    );
    const newerVersion = newer.rows[0]?.version;
    if (newerVersion !== undefined) {
      throw new Error(
        `Database migration ${newerVersion} is newer than binary migration ${latestKnownVersion}`,
      );
    }
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
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }

  let cleanupError: Error | undefined;
  try {
    await client.query("RESET statement_timeout");
    await client.query("RESET lock_timeout");
    if (advisoryLockHeld) {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    }
  } catch (error) {
    cleanupError =
      error instanceof Error
        ? error
        : new Error("Migration connection cleanup failed");
  }
  client.release(cleanupError);
  if (operationFailed) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
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
