import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../../src/persistence/postgres/migration-runner.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

async function copyMigrations(pattern = /^\d{3}_.*\.sql$/): Promise<string> {
  const source = join(process.cwd(), "migrations");
  const target = await mkdtemp(join(tmpdir(), "skillwire-migrations-"));
  for (const name of (await readdir(source)).filter((name) =>
    pattern.test(name),
  )) {
    await writeFile(
      join(target, name),
      await readFile(join(source, name), "utf8"),
    );
  }
  return target;
}

describe("versioned PostgreSQL migrations", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 120_000);

  afterAll(async () => database.close());

  it("applies each migration once and supports concurrent runners", async () => {
    await Promise.all([
      runMigrations(database.pool),
      runMigrations(database.pool),
    ]);
    await runMigrations(database.pool);

    const result = await database.pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(result.rows.map((row) => row.version)).toEqual([
      "001",
      "002",
      "003",
      "004",
      "005",
      "006",
      "007",
      "008",
      "009",
      "010",
      "011",
    ]);
  });

  it("rejects checksum drift", async () => {
    const target = await copyMigrations();
    try {
      const first = join(target, "001_accounts_and_api_keys.sql");
      await writeFile(first, `${await readFile(first, "utf8")}\n-- drift\n`);

      await expect(runMigrations(database.pool, target)).rejects.toThrow(
        /checksum drift/i,
      );
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("rejects a database newer than the binary migration directory", async () => {
    const target = await copyMigrations(/^00[1-9]_.*\.sql$/);
    try {
      await expect(runMigrations(database.pool, target)).rejects.toThrow(
        /database migration 010 is newer than binary migration 009/i,
      );
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("rejects unbounded migration timeout configuration", async () => {
    await expect(
      runMigrations(database.pool, undefined, {
        lockTimeoutMilliseconds: 0,
      }),
    ).rejects.toThrow(/lock_timeout_ms must be a positive bounded integer/i);
    await expect(
      runMigrations(database.pool, undefined, {
        statementTimeoutMilliseconds: 3_600_001,
      }),
    ).rejects.toThrow(
      /statement_timeout_ms must be a positive bounded integer/i,
    );
  });

  it("times out behind a forgotten writer and recovers through the latest migration", async () => {
    const legacy = await createTestDatabase();
    const target = await copyMigrations(/^00[1-9]_.*\.sql$/);
    const blocker = await legacy.pool.connect();
    try {
      await runMigrations(legacy.pool, target);
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE external_current_classifications IN ACCESS EXCLUSIVE MODE",
      );

      await expect(
        runMigrations(legacy.pool, undefined, {
          lockTimeoutMilliseconds: 50,
          statementTimeoutMilliseconds: 5_000,
        }),
      ).rejects.toThrow(/lock timeout|lock_not_available|canceling statement/i);
      expect(
        (
          await blocker.query<{
            migration_registered: boolean;
            revision_events: string | null;
          }>(
            `SELECT
               EXISTS (SELECT 1 FROM schema_migrations WHERE version='010')
                 AS migration_registered,
               to_regclass('public.external_revision_classification_events')::text
                 AS revision_events`,
          )
        ).rows,
      ).toEqual([{ migration_registered: false, revision_events: null }]);
      await blocker.query("COMMIT");

      await runMigrations(legacy.pool, target);
      await runMigrations(legacy.pool, undefined, {
        lockTimeoutMilliseconds: 5_000,
        statementTimeoutMilliseconds: 30_000,
      });
      expect(
        (
          await legacy.pool.query<{ version: string }>(
            "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
          )
        ).rows,
      ).toEqual([{ version: "011" }]);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await legacy.close();
      await rm(target, { recursive: true, force: true });
    }
  }, 120_000);

  it("rolls back a statement timeout and applies the corrected migration once", async () => {
    const isolated = await createTestDatabase();
    const target = await mkdtemp(
      join(tmpdir(), "skillwire-timeout-migration-"),
    );
    const migration = join(target, "001_timeout_probe.sql");
    try {
      await writeFile(
        migration,
        "CREATE TABLE timeout_probe (id integer PRIMARY KEY); SELECT pg_sleep(1);\n",
      );
      await expect(
        runMigrations(isolated.pool, target, {
          lockTimeoutMilliseconds: 1_000,
          statementTimeoutMilliseconds: 50,
        }),
      ).rejects.toThrow(/statement timeout|canceling statement/i);
      expect(
        (
          await isolated.pool.query<{
            migration_registered: boolean;
            timeout_probe: string | null;
          }>(
            `SELECT
                 EXISTS (SELECT 1 FROM schema_migrations WHERE version='001')
                   AS migration_registered,
                 to_regclass('public.timeout_probe')::text AS timeout_probe`,
          )
        ).rows,
      ).toEqual([{ migration_registered: false, timeout_probe: null }]);

      await writeFile(
        migration,
        "CREATE TABLE timeout_probe (id integer PRIMARY KEY);\n",
      );
      await runMigrations(isolated.pool, target, {
        lockTimeoutMilliseconds: 1_000,
        statementTimeoutMilliseconds: 5_000,
      });
      await runMigrations(isolated.pool, target, {
        lockTimeoutMilliseconds: 1_000,
        statementTimeoutMilliseconds: 5_000,
      });
      expect(
        (
          await isolated.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM schema_migrations WHERE version='001'",
          )
        ).rows,
      ).toEqual([{ count: "1" }]);
    } finally {
      await isolated.close();
      await rm(target, { recursive: true, force: true });
    }
  }, 120_000);
});
