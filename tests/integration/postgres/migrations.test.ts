import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../../src/persistence/postgres/migration-runner.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

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
    ]);
  });

  it("rejects checksum drift", async () => {
    const source = join(process.cwd(), "migrations");
    const target = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "skillwire-migrations-")),
    );
    for (const name of [
      "001_accounts_and_api_keys.sql",
      "002_repository_skill_usage.sql",
      "003_repository_erasure_audit.sql",
      "004_github_sources_and_jobs.sql",
      "005_external_catalog_revisions.sql",
    ]) {
      const content = await readFile(join(source, name), "utf8");
      await writeFile(
        join(target, name),
        name.startsWith("001") ? `${content}\n-- drift\n` : content,
      );
    }

    await expect(runMigrations(database.pool, target)).rejects.toThrow(
      /checksum drift/i,
    );
  });
});
