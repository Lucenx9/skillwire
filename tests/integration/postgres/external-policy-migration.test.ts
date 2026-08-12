import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

describe("external policy migration", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
  }, 120_000);

  afterAll(async () => database.close());

  it("installs migration 006 policy, discovery, leases, and external advisory history", async () => {
    const versions = await database.pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(versions.rows.at(-1)?.version).toBe("008");
    const required = [
      "github_discovery_runs",
      "github_discovery_evidence",
      "github_job_leases",
      "external_import_candidates",
      "external_verification_reports",
      "external_validation_findings",
      "external_classification_events",
      "external_current_classifications",
      "external_current_revision_classifications",
      "external_curation_decisions",
      "external_advisory_chain_head",
      "external_revision_advisory_events",
    ];
    const tables = await database.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [required],
    );
    expect(new Set(tables.rows.map(({ table_name }) => table_name))).toEqual(
      new Set(required),
    );
    await expect(
      database.pool.query(
        "UPDATE external_advisory_chain_head SET last_sequence = 1 WHERE singleton",
      ),
    ).resolves.toBeDefined();
    expect(
      (
        await database.pool.query<{ last_event_sha256: string }>(
          "SELECT last_event_sha256 FROM external_advisory_chain_head WHERE singleton",
        )
      ).rows[0]?.last_event_sha256,
    ).toBe("0".repeat(64));
    expect(randomUUID()).toMatch(/-/);
  });
});
