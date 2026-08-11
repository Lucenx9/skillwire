import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

describe("GitHub ingestion migrations", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
  }, 120_000);

  afterAll(async () => database.close());

  it("upgrades Feature 001 and records additive migration checksums", async () => {
    const versions = await database.pool.query<{
      version: string;
      checksum: string;
    }>("SELECT version, checksum FROM schema_migrations ORDER BY version");
    expect(versions.rows.map(({ version }) => version)).toEqual([
      "001",
      "002",
      "003",
      "004",
      "005",
      "006",
    ]);
    expect(
      versions.rows.every(({ checksum }) => /^[0-9a-f]{64}$/.test(checksum)),
    ).toBe(true);

    const legacyTables = await database.pool.query<{ name: string }>(
      `
        SELECT table_name AS name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('accounts', 'api_keys', 'repository_skill_usage', 'repository_erasure_audit')
        ORDER BY table_name
      `,
    );
    expect(legacyTables.rows.map(({ name }) => name)).toHaveLength(4);
  });

  it("enforces exact hashes, safe paths, and create-only history", async () => {
    const sourceId = randomUUID();
    const snapshotId = randomUUID();
    await database.pool.query(
      `
        INSERT INTO github_sources (
          id, github_repository_id, owner, repository, normalized_owner,
          normalized_repository, default_branch
        ) VALUES ($1, 1148788086, 'mattpocock', 'skills', 'mattpocock', 'skills', 'main')
      `,
      [sourceId],
    );
    await database.pool.query(
      `
        INSERT INTO external_source_snapshots (
          id, source_id, commit_sha, tree_sha, manifest_version, revision_count
        ) VALUES ($1, $2, $3, $4, '1.2.3', 25)
      `,
      [snapshotId, sourceId, "8".repeat(40), "1".repeat(40)],
    );
    await expect(
      database.pool.query(
        "UPDATE external_source_snapshots SET manifest_version = '9.9.9' WHERE id = $1",
        [snapshotId],
      ),
    ).rejects.toThrow(/immutable/i);
    await expect(
      database.pool.query(
        `
          INSERT INTO external_source_snapshots (
            id, source_id, commit_sha, tree_sha, manifest_version, revision_count
          ) VALUES ($1, $2, 'UPPERCASE', $3, '1.2.3', 1)
        `,
        [randomUUID(), sourceId, "1".repeat(40)],
      ),
    ).rejects.toThrow();
    await expect(
      database.pool.query(
        `
          INSERT INTO external_revision_resources (
            revision_id, resource_path, media_type, byte_length, content_sha256, ordinal
          ) VALUES ($1, '../secret.md', 'text/markdown', 0, $2, 0)
        `,
        [randomUUID(), "a".repeat(64)],
      ),
    ).rejects.toThrow();
  });
});
