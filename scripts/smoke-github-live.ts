import { randomUUID } from "node:crypto";

import { SourceRegistrationService } from "../src/application/services/source-registration-service.js";
import { SourceSynchronizationService } from "../src/application/services/source-synchronization-service.js";
import { GitHubCommitTreeBlobReader } from "../src/ingestion/github/commit-tree-blob-reader.js";
import { GitHubRestClient } from "../src/ingestion/github/rest-client.js";
import { createPostgresPool } from "../src/persistence/postgres/client.js";
import { PostgresExternalCatalogStore } from "../src/persistence/postgres/external-catalog-store.js";
import { runMigrations } from "../src/persistence/postgres/migration-runner.js";
import { PostgresSyncLeaseStore } from "../src/persistence/postgres/sync-lease-store.js";

const ACCEPTANCE_COMMIT = "84fdeffd12f2ee307994d1eb6feb48173b6e0502";

async function main(): Promise<void> {
  const token = process.env["GITHUB_TOKEN"];
  if (token === undefined || token.length < 20) {
    process.stdout.write(
      `${JSON.stringify({ skipped: true, reason: "GITHUB_TOKEN_REQUIRED" })}\n`,
    );
    return;
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined) throw new Error("DATABASE_URL_REQUIRED");
  const pool = createPostgresPool(databaseUrl);
  try {
    await runMigrations(pool);
    const reader = new GitHubCommitTreeBlobReader(
      new GitHubRestClient({ token }),
    );
    const store = new PostgresExternalCatalogStore(pool);
    const registration = await new SourceRegistrationService(reader, store).add(
      { owner: "mattpocock", repository: "skills" },
      "live-smoke-admin",
    );
    const leaseStore = new PostgresSyncLeaseStore(pool);
    const lease = await leaseStore.acquire(
      `sync/${registration.sourceId}`,
      randomUUID(),
      60_000,
    );
    if (lease === undefined) throw new Error("LEASE_HELD");
    try {
      const imported = await new SourceSynchronizationService(
        reader,
        store,
      ).syncScheduled(
        registration.sourceId,
        lease,
        { deadline: Date.now() + 10 * 60_000 },
        ACCEPTANCE_COMMIT,
        {
          repositoryId: registration.repository.repositoryId,
          owner: registration.repository.owner,
          repository: registration.repository.repository,
        },
      );
      if (
        imported.commitSha !== ACCEPTANCE_COMMIT ||
        imported.traces.length !== 25 ||
        imported.candidateTraces.length !== 25 ||
        imported.candidateTraces.some(
          ({ classification }) => classification !== "verified",
        ) ||
        imported.resourceCount !== 21
      ) {
        throw new Error("ACCEPTANCE_INVENTORY_MISMATCH");
      }
      const persisted = await pool.query<{
        skills: string;
        resources: string;
        licenses: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM external_skill_revisions r
            JOIN external_source_snapshots s ON s.id=r.snapshot_id
            WHERE s.source_id=$1 AND s.commit_sha=$2) AS skills,
           (SELECT count(*)::text FROM external_revision_resources rr
            JOIN external_skill_revisions r ON r.id=rr.revision_id
            JOIN external_source_snapshots s ON s.id=r.snapshot_id
            WHERE s.source_id=$1 AND s.commit_sha=$2) AS resources,
           (SELECT count(DISTINCT r.spdx_license_id)::text
            FROM external_skill_revisions r
            JOIN external_source_snapshots s ON s.id=r.snapshot_id
            WHERE s.source_id=$1 AND s.commit_sha=$2 AND r.spdx_license_id='MIT') AS licenses`,
        [registration.sourceId, ACCEPTANCE_COMMIT],
      );
      const persistedRow = persisted.rows[0];
      if (
        persistedRow?.skills !== "25" ||
        persistedRow.resources !== "21" ||
        persistedRow.licenses !== "1"
      ) {
        throw new Error("ACCEPTANCE_PERSISTENCE_MISMATCH");
      }
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          repositoryId: registration.repository.repositoryId,
          commitSha: ACCEPTANCE_COMMIT,
          treeSha: imported.treeSha,
          skillCount: 25,
          resourceCount: 21,
          license: "MIT",
        })}\n`,
      );
    } finally {
      await leaseStore.release(lease);
    }
  } finally {
    await pool.end();
  }
}

await main();
