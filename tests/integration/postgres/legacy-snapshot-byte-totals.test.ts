import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../../../src/persistence/postgres/migration-runner.js";
import {
  assessRestoredDatabaseEvidence,
  databaseStateExpectation,
  expectedMigrationInventory,
  forwardMigrationStateExpectation,
  readDatabaseEvidence,
} from "../../../src/onboarding/adapters/postgres/restore-validation.js";
import type { CommandOptions } from "../../../src/onboarding/adapters/process/command-runner.js";
import { createTestDatabase } from "../../helpers/database.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function copyMigrationsThrough009(): Promise<string> {
  const source = join(process.cwd(), "migrations");
  const target = await mkdtemp(join(tmpdir(), "skillwire-byte-total-009-"));
  for (const name of (await readdir(source)).filter((name) =>
    /^00[1-9]_.*\.sql$/.test(name),
  )) {
    await writeFile(
      join(target, name),
      await readFile(join(source, name), "utf8"),
    );
  }
  return target;
}

async function insertLegacyVerifiedSnapshot(
  pool: Pool | PoolClient,
  options: {
    readonly corruptBundleHash?: boolean;
    readonly corruptContentHash?: boolean;
    readonly storedByteTotal?: number;
  } = {},
): Promise<{
  readonly canonicalBytes: string;
  readonly canonicalByteTotal: number;
  readonly contentIdentitySha256: string;
  readonly identityId: string;
  readonly legacyByteTotal: number;
  readonly revisionId: string;
  readonly snapshotId: string;
  readonly sourceId: string;
}> {
  const sourceId = randomUUID();
  const snapshotId = randomUUID();
  const identityId = randomUUID();
  const revisionId = randomUUID();
  const candidateId = randomUUID();
  const reportId = randomUUID();
  const discoveredEventId = randomUUID();
  const verifiedEventId = randomUUID();
  const instructions = "legacy instructions";
  const resource = "legacy resource";
  const license = "MIT";
  const canonicalBytes = JSON.stringify({
    schemaVersion: 2,
    skillId: "legacy-byte-total-skill",
    instructions,
    resources: [{ path: "references/example.md", content: resource }],
  });
  const legacyByteTotal =
    Buffer.byteLength(instructions, "utf8") +
    Buffer.byteLength(resource, "utf8");
  const canonicalByteTotal = Buffer.byteLength(canonicalBytes, "utf8");
  const instructionsSha256 = options.corruptContentHash
    ? "1".repeat(64)
    : sha256(instructions);
  expect(legacyByteTotal).not.toBe(canonicalByteTotal);

  await pool.query(
    `INSERT INTO github_sources (
       id,github_repository_id,owner,repository,normalized_owner,
       normalized_repository,default_branch
     ) VALUES ($1,9001,'fixture-owner','fixture-repository','fixture-owner',
               'fixture-repository','main')`,
    [sourceId],
  );
  await pool.query(
    `INSERT INTO external_source_snapshots (
       id,source_id,commit_sha,tree_sha,manifest_version,revision_count,
       adapter_kind,candidate_count,quarantine_count,resource_count,
       dependency_count,decoded_bytes,validation_input_sha256,
       advisory_chain_head_sha256,origin_github_repository_id,origin_owner,
       origin_repository
     ) VALUES ($1,$2,$3,$4,'nested-v1',1,'nested-skill',1,0,1,0,$5,$6,$7,
               9001,'fixture-owner','fixture-repository')`,
    [
      snapshotId,
      sourceId,
      "a".repeat(40),
      "b".repeat(40),
      options.storedByteTotal ?? legacyByteTotal,
      "c".repeat(64),
      "0".repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO external_content_objects (
       sha256,kind,media_type,byte_length,content
     ) VALUES
       ($1,'instructions','text/markdown',$2,$3),
       ($4,'resource','text/markdown',$5,$6),
       ($7,'license','text/plain',$8,$9)`,
    [
      instructionsSha256,
      Buffer.byteLength(instructions, "utf8"),
      instructions,
      sha256(resource),
      Buffer.byteLength(resource, "utf8"),
      resource,
      sha256(license),
      Buffer.byteLength(license, "utf8"),
      license,
    ],
  );
  await pool.query(
    `INSERT INTO external_skill_identities (
       id,source_id,catalog_skill_id,normalized_skill_root
     ) VALUES ($1,$2,'legacy-byte-total-skill','skills/legacy-byte-total')`,
    [identityId, sourceId],
  );
  await pool.query(
    `INSERT INTO external_skill_revisions (
       id,skill_identity_id,snapshot_id,revision,bundle_sha256,
       content_identity_sha256,name,description,skill_path,commit_sha,
       source_owner,spdx_license_id,license_sha256,instructions_sha256,
       invocation_mode,canonical_bytes,origin_owner,origin_repository
     ) VALUES ($1,$2,$3,$4,$5,$6,'legacy-byte-total-skill',
               'Sanitized legacy byte-total fixture.',
               'skills/legacy-byte-total/SKILL.md',$7,'Fixture Owner','MIT',$8,
               $9,'automatic',$10,'fixture-owner','fixture-repository')`,
    [
      revisionId,
      identityId,
      snapshotId,
      `gh-${sha256(canonicalBytes)}`,
      options.corruptBundleHash ? "2".repeat(64) : sha256(canonicalBytes),
      sha256(`identity:${canonicalBytes}`),
      "a".repeat(40),
      sha256(license),
      instructionsSha256,
      canonicalBytes,
    ],
  );
  await pool.query(
    `INSERT INTO external_revision_resources (
       revision_id,resource_path,media_type,byte_length,content_sha256,ordinal
     ) VALUES ($1,'references/example.md','text/markdown',$2,$3,0)`,
    [revisionId, Buffer.byteLength(resource, "utf8"), sha256(resource)],
  );
  await pool.query(
    `INSERT INTO external_import_candidates (
       id,snapshot_id,adapter_kind,normalized_skill_root,normalized_name,
       display_name,description,skill_document_path,source_path_sha256
     ) VALUES ($1,$2,'nested-skill','skills/legacy-byte-total',
               'legacy-byte-total-skill','legacy-byte-total-skill',
               'Sanitized legacy byte-total fixture.',
               'skills/legacy-byte-total/SKILL.md',$3)`,
    [candidateId, snapshotId, "d".repeat(64)],
  );
  await pool.query(
    `INSERT INTO external_verification_reports (
       id,candidate_id,policy_version,validator_version,input_sha256,
       report_sha256,result
     ) VALUES ($1,$2,'external-policy-v1','external-validator-v1',$3,$4,
               'passed')`,
    [reportId, candidateId, "e".repeat(64), "f".repeat(64)],
  );
  await pool.query(
    `INSERT INTO external_classification_events (
       id,candidate_id,previous_classification,next_classification,
       actor_kind,actor_id,reason_code,report_id
     ) VALUES ($1,$2,NULL,'discovered','synchronization','legacy-fixture',
               'CANDIDATE_DISCOVERED',NULL)`,
    [discoveredEventId, candidateId],
  );
  await pool.query(
    `INSERT INTO external_current_classifications (
       candidate_id,classification,latest_event_id
     ) VALUES ($1,'discovered',$2)`,
    [candidateId, discoveredEventId],
  );
  await pool.query(
    `INSERT INTO external_classification_events (
       id,candidate_id,previous_classification,next_classification,
       actor_kind,actor_id,reason_code,report_id
     ) VALUES ($1,$2,'discovered','verified','verifier','legacy-fixture',
               'AUTOMATIC_VERIFICATION_PASSED',$3)`,
    [verifiedEventId, candidateId, reportId],
  );
  await pool.query(
    `UPDATE external_current_classifications
        SET classification='verified',latest_event_id=$2
      WHERE candidate_id=$1`,
    [candidateId, verifiedEventId],
  );
  await pool.query(
    `INSERT INTO external_snapshot_skill_observations (
       snapshot_id,skill_identity_id,revision_id,result,candidate_id,
       observed_content_identity_sha256
     ) VALUES ($1,$2,$3,'published',$4,$5)`,
    [
      snapshotId,
      identityId,
      revisionId,
      candidateId,
      sha256(`identity:${canonicalBytes}`),
    ],
  );
  const schema = await pool.query<{ latest: string }>(
    "SELECT max(version) AS latest FROM schema_migrations",
  );
  let revisionEventId = verifiedEventId;
  if ((schema.rows[0]?.latest ?? "000") >= "010") {
    revisionEventId = randomUUID();
    await pool.query(
      `INSERT INTO external_revision_classification_events (
         id,revision_id,initiating_candidate_id,previous_classification,
         next_classification,actor_kind,actor_id,reason_code,report_id
       ) VALUES ($1,$2,$3,NULL,'verified','verifier','legacy-fixture',
                 'AUTOMATIC_VERIFICATION_PASSED',$4)`,
      [revisionEventId, revisionId, candidateId, reportId],
    );
  }
  await pool.query(
    `INSERT INTO external_current_revision_classifications (
       revision_id,classification,latest_event_id
     ) VALUES ($1,'verified',$2)`,
    [revisionId, revisionEventId],
  );
  return {
    canonicalBytes,
    canonicalByteTotal,
    contentIdentitySha256: sha256(`identity:${canonicalBytes}`),
    identityId,
    legacyByteTotal,
    revisionId,
    snapshotId,
    sourceId,
  };
}

async function insertSharedAndQuarantinedSnapshots(
  pool: Pool,
  fixture: Awaited<ReturnType<typeof insertLegacyVerifiedSnapshot>>,
): Promise<{
  readonly quarantinedSnapshotId: string;
  readonly sharedSnapshotId: string;
}> {
  const sharedSnapshotId = randomUUID();
  const sharedCandidateId = randomUUID();
  const sharedReportId = randomUUID();
  const sharedDiscoveredId = randomUUID();
  const sharedVerifiedId = randomUUID();
  await pool.query(
    `INSERT INTO external_source_snapshots (
       id,source_id,commit_sha,tree_sha,manifest_version,revision_count,
       adapter_kind,candidate_count,quarantine_count,resource_count,
       dependency_count,decoded_bytes,validation_input_sha256,
       advisory_chain_head_sha256,origin_github_repository_id,origin_owner,
       origin_repository
     ) VALUES ($1,$2,$3,$4,'nested-v1',1,'nested-skill',1,0,1,0,$5,$6,$7,
               9001,'fixture-owner','fixture-repository')`,
    [
      sharedSnapshotId,
      fixture.sourceId,
      "1".repeat(40),
      "2".repeat(40),
      fixture.legacyByteTotal,
      "3".repeat(64),
      "0".repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO external_import_candidates (
       id,snapshot_id,adapter_kind,normalized_skill_root,normalized_name,
       display_name,description,skill_document_path,source_path_sha256
     ) VALUES ($1,$2,'nested-skill','skills/legacy-byte-total',
               'legacy-byte-total-skill','legacy-byte-total-skill',
               'Sanitized shared-revision fixture.',
               'skills/legacy-byte-total/SKILL.md',$3)`,
    [sharedCandidateId, sharedSnapshotId, "4".repeat(64)],
  );
  await pool.query(
    `INSERT INTO external_verification_reports (
       id,candidate_id,policy_version,validator_version,input_sha256,
       report_sha256,result
     ) VALUES ($1,$2,'external-policy-v1','external-validator-v1',$3,$4,
               'passed')`,
    [sharedReportId, sharedCandidateId, "5".repeat(64), "6".repeat(64)],
  );
  await pool.query(
    `INSERT INTO external_classification_events (
       id,candidate_id,previous_classification,next_classification,
       actor_kind,actor_id,reason_code,report_id
     ) VALUES
       ($1,$3,NULL,'discovered','synchronization','legacy-fixture',
        'CANDIDATE_DISCOVERED',NULL),
       ($2,$3,'discovered','verified','verifier','legacy-fixture',
        'AUTOMATIC_VERIFICATION_PASSED',$4)`,
    [sharedDiscoveredId, sharedVerifiedId, sharedCandidateId, sharedReportId],
  );
  await pool.query(
    `INSERT INTO external_current_classifications (
       candidate_id,classification,latest_event_id
     ) VALUES ($1,'verified',$2)`,
    [sharedCandidateId, sharedVerifiedId],
  );
  await pool.query(
    `INSERT INTO external_snapshot_skill_observations (
       snapshot_id,skill_identity_id,revision_id,result,candidate_id,
       observed_content_identity_sha256
     ) VALUES ($1,$2,$3,'reused',$4,$5)`,
    [
      sharedSnapshotId,
      fixture.identityId,
      fixture.revisionId,
      sharedCandidateId,
      fixture.contentIdentitySha256,
    ],
  );

  const quarantinedSnapshotId = randomUUID();
  const quarantinedCandidateId = randomUUID();
  const quarantinedReportId = randomUUID();
  const quarantinedDiscoveredId = randomUUID();
  const quarantinedEventId = randomUUID();
  await pool.query(
    `INSERT INTO external_source_snapshots (
       id,source_id,commit_sha,tree_sha,manifest_version,revision_count,
       adapter_kind,candidate_count,quarantine_count,resource_count,
       dependency_count,decoded_bytes,validation_input_sha256,
       advisory_chain_head_sha256,origin_github_repository_id,origin_owner,
       origin_repository
     ) VALUES ($1,$2,$3,$4,'nested-v1',0,'nested-skill',1,1,0,0,0,$5,$6,
               9001,'fixture-owner','fixture-repository')`,
    [
      quarantinedSnapshotId,
      fixture.sourceId,
      "7".repeat(40),
      "8".repeat(40),
      "9".repeat(64),
      "0".repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO external_import_candidates (
       id,snapshot_id,adapter_kind,normalized_skill_root,normalized_name,
       display_name,description,skill_document_path,source_path_sha256
     ) VALUES ($1,$2,'nested-skill','skills/quarantined',
               'quarantined-skill','quarantined-skill',
               'Sanitized quarantined fixture.',
               'skills/quarantined/SKILL.md',$3)`,
    [quarantinedCandidateId, quarantinedSnapshotId, "a".repeat(64)],
  );
  await pool.query(
    `INSERT INTO external_verification_reports (
       id,candidate_id,policy_version,validator_version,input_sha256,
       report_sha256,result
     ) VALUES ($1,$2,'external-policy-v1','external-validator-v1',$3,$4,
               'failed')`,
    [
      quarantinedReportId,
      quarantinedCandidateId,
      "b".repeat(64),
      "c".repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO external_classification_events (
       id,candidate_id,previous_classification,next_classification,
       actor_kind,actor_id,reason_code,report_id
     ) VALUES
       ($1,$3,NULL,'discovered','synchronization','legacy-fixture',
        'CANDIDATE_DISCOVERED',NULL),
       ($2,$3,'discovered','quarantined','verifier','legacy-fixture',
        'AUTOMATIC_VERIFICATION_FAILED',$4)`,
    [
      quarantinedDiscoveredId,
      quarantinedEventId,
      quarantinedCandidateId,
      quarantinedReportId,
    ],
  );
  await pool.query(
    `INSERT INTO external_current_classifications (
       candidate_id,classification,latest_event_id
     ) VALUES ($1,'quarantined',$2)`,
    [quarantinedCandidateId, quarantinedEventId],
  );
  await pool.query(
    `INSERT INTO external_snapshot_skill_observations (
       snapshot_id,skill_identity_id,revision_id,result
     ) VALUES ($1,$2,NULL,'missing')`,
    [quarantinedSnapshotId, fixture.identityId],
  );
  return { quarantinedSnapshotId, sharedSnapshotId };
}

async function readFixtureEvidence(
  pool: Pool,
  installationAccountId = randomUUID(),
) {
  return readDatabaseEvidence({
    dockerExecutable: "/usr/bin/docker",
    dockerArgs: [],
    databaseName: "skillwire",
    databaseUser: "skillwire",
    environment: {},
    signal: new AbortController().signal,
    installationAccountId,
    run: async (options: CommandOptions) => {
      const query = options.args.at(-1);
      if (query === undefined) throw new Error("Missing evidence query");
      const result = await pool.query<{ evidence: unknown }>(
        `SELECT (${query})::json AS evidence`,
      );
      return {
        code: 0,
        stdout: `${JSON.stringify(result.rows[0]?.evidence)}\n`,
        stderr: "",
        durationMilliseconds: 0,
      };
    },
  });
}

describe("legacy imported snapshot byte totals", () => {
  it.each([
    ["without reconciliation evidence", false],
    ["with fabricated reconciliation evidence", true],
  ] as const)(
    "rejects a pre-011 writer %s",
    async (_scenario, fabricateEvidence) => {
      const database = await createTestDatabase();
      const client = await database.pool.connect();
      try {
        await runMigrations(database.pool);
        await client.query("BEGIN");
        const fixture = await insertLegacyVerifiedSnapshot(client);
        if (fabricateEvidence) {
          await client.query(
            `INSERT INTO external_snapshot_byte_total_reconciliations (
               snapshot_id,prior_decoded_bytes,legacy_payload_decoded_bytes,
               reconciled_decoded_bytes,prior_representation
             ) VALUES ($1,$2,$2,$3,'legacy-payload')`,
            [
              fixture.snapshotId,
              fixture.legacyByteTotal,
              fixture.canonicalByteTotal,
            ],
          );
        }

        await expect(client.query("COMMIT")).rejects.toThrow(
          /snapshot byte-total projection is invalid/i,
        );
        await client.query("ROLLBACK").catch(() => undefined);
      } finally {
        client.release();
        await database.close();
      }
    },
    120_000,
  );

  it.each([
    [
      "malformed content hash",
      { corruptContentHash: true },
      /content objects/i,
    ],
    [
      "canonical revision hash drift",
      { corruptBundleHash: true },
      /canonical revisions/i,
    ],
    ["arbitrary byte total", { storedByteTotal: 42 }, /unsupported totals/i],
  ] as const)(
    "fails closed and rolls migration 011 back for %s",
    async (_name, options, message) => {
      const database = await createTestDatabase();
      const legacyMigrations = await copyMigrationsThrough009();
      try {
        await runMigrations(database.pool, legacyMigrations);
        const fixture = await insertLegacyVerifiedSnapshot(
          database.pool,
          options,
        );
        if ("storedByteTotal" in options) {
          const evidence = await readFixtureEvidence(database.pool);
          expect(evidence.catalog).toMatchObject({
            legacySnapshotByteTotals: 0,
            invalidSnapshotByteTotals: 1,
          });
        }

        await expect(runMigrations(database.pool)).rejects.toThrow(message);
        const state = await database.pool.query<{
          audit_table: string | null;
          immutable_trigger_enabled: string;
          migration_010: boolean;
          migration_011: boolean;
          stored_decoded_bytes: string;
        }>(
          `SELECT
             to_regclass('public.external_snapshot_byte_total_reconciliations')::text
               AS audit_table,
             (SELECT tgenabled FROM pg_trigger
               WHERE tgname='external_snapshots_immutable')
               AS immutable_trigger_enabled,
             EXISTS (SELECT 1 FROM schema_migrations WHERE version='010')
               AS migration_010,
             EXISTS (SELECT 1 FROM schema_migrations WHERE version='011')
               AS migration_011,
             (SELECT decoded_bytes::text FROM external_source_snapshots
               WHERE id=$1) AS stored_decoded_bytes`,
          [fixture.snapshotId],
        );
        expect(state.rows).toEqual([
          {
            audit_table: null,
            immutable_trigger_enabled: "O",
            migration_010: true,
            migration_011: false,
            stored_decoded_bytes: String(
              "storedByteTotal" in options
                ? options.storedByteTotal
                : fixture.legacyByteTotal,
            ),
          },
        ]);
      } finally {
        await database.close();
        await rm(legacyMigrations, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("rejects malformed null-revision observations before reconciliation", async () => {
    const database = await createTestDatabase();
    const legacyMigrations = await copyMigrationsThrough009();
    try {
      await runMigrations(database.pool, legacyMigrations);
      const fixture = await insertLegacyVerifiedSnapshot(database.pool);
      const { quarantinedSnapshotId } =
        await insertSharedAndQuarantinedSnapshots(database.pool, fixture);
      await database.pool.query(
        `ALTER TABLE external_snapshot_skill_observations
           DISABLE TRIGGER external_observations_immutable`,
      );
      await database.pool.query(
        `UPDATE external_snapshot_skill_observations
            SET observed_content_identity_sha256=$2
          WHERE snapshot_id=$1 AND revision_id IS NULL`,
        [quarantinedSnapshotId, "f".repeat(64)],
      );
      await database.pool.query(
        `ALTER TABLE external_snapshot_skill_observations
           ENABLE TRIGGER external_observations_immutable`,
      );

      const evidence = await readFixtureEvidence(database.pool);
      expect(evidence.catalog.invalidSnapshotObjectGraph).toBe(1);
      await expect(runMigrations(database.pool)).rejects.toThrow(
        /malformed observation attribution/i,
      );
    } finally {
      await database.close();
      await rm(legacyMigrations, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects a missing authoritative content object before reconciliation", async () => {
    const database = await createTestDatabase();
    const legacyMigrations = await copyMigrationsThrough009();
    try {
      await runMigrations(database.pool, legacyMigrations);
      const fixture = await insertLegacyVerifiedSnapshot(database.pool);
      await database.pool.query(
        `ALTER TABLE external_skill_revisions
           DISABLE TRIGGER external_revisions_immutable`,
      );
      await database.pool.query(
        `ALTER TABLE external_skill_revisions
           DROP CONSTRAINT external_skill_revisions_instructions_sha256_fkey`,
      );
      await database.pool.query(
        `UPDATE external_skill_revisions
            SET instructions_sha256=$2
          WHERE id=$1`,
        [fixture.revisionId, "0".repeat(64)],
      );
      await database.pool.query(
        `ALTER TABLE external_skill_revisions
           ENABLE TRIGGER external_revisions_immutable`,
      );

      await expect(runMigrations(database.pool)).rejects.toThrow(
        /malformed catalog objects/i,
      );
    } finally {
      await database.close();
      await rm(legacyMigrations, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects duplicate per-snapshot revision accounting", async () => {
    const database = await createTestDatabase();
    const legacyMigrations = await copyMigrationsThrough009();
    try {
      await runMigrations(database.pool, legacyMigrations);
      const fixture = await insertLegacyVerifiedSnapshot(database.pool);
      await database.pool.query(
        `ALTER TABLE external_snapshot_skill_observations
           DISABLE TRIGGER external_observations_immutable`,
      );
      await database.pool.query(
        `ALTER TABLE external_snapshot_skill_observations
           DROP CONSTRAINT external_snapshot_skill_observations_pkey`,
      );
      await database.pool.query(
        `INSERT INTO external_snapshot_skill_observations (
           snapshot_id,skill_identity_id,revision_id,result,candidate_id,
           observed_content_identity_sha256
         ) SELECT snapshot_id,skill_identity_id,revision_id,result,candidate_id,
                  observed_content_identity_sha256
             FROM external_snapshot_skill_observations
            WHERE snapshot_id=$1`,
        [fixture.snapshotId],
      );
      await database.pool.query(
        `ALTER TABLE external_snapshot_skill_observations
           ENABLE TRIGGER external_observations_immutable`,
      );

      await expect(runMigrations(database.pool)).rejects.toThrow(
        /duplicate revision accounting/i,
      );
    } finally {
      await database.close();
      await rm(legacyMigrations, { recursive: true, force: true });
    }
  }, 120_000);

  it("reconciles verified, quarantined, missing, and shared-revision snapshots idempotently", async () => {
    const database = await createTestDatabase();
    const legacyMigrations = await copyMigrationsThrough009();
    try {
      await runMigrations(database.pool, legacyMigrations);
      const fixture = await insertLegacyVerifiedSnapshot(database.pool);
      const snapshots = await insertSharedAndQuarantinedSnapshots(
        database.pool,
        fixture,
      );

      await runMigrations(database.pool);
      await runMigrations(database.pool);
      await expect(
        database.pool.query(
          "TRUNCATE external_snapshot_byte_total_reconciliations",
        ),
      ).rejects.toThrow(/immutable/i);

      const result = await database.pool.query<{
        audit_count: string;
        canonical_snapshots: string;
        legacy_reconciliations: string;
        migration_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text
              FROM external_snapshot_byte_total_reconciliations) AS audit_count,
           (SELECT count(*)::text
              FROM external_source_snapshots snapshot
              WHERE snapshot.decoded_bytes=(
                SELECT COALESCE(sum(octet_length(revision.canonical_bytes)),0)
                FROM external_snapshot_skill_observations observation
                JOIN external_skill_revisions revision
                  ON revision.id=observation.revision_id
                WHERE observation.snapshot_id=snapshot.id
              )) AS canonical_snapshots,
           (SELECT count(*)::text
              FROM external_snapshot_byte_total_reconciliations
              WHERE prior_representation='legacy-payload')
             AS legacy_reconciliations,
           (SELECT count(*)::text FROM schema_migrations WHERE version='011')
             AS migration_count`,
      );
      expect(result.rows).toEqual([
        {
          audit_count: "3",
          canonical_snapshots: "3",
          legacy_reconciliations: "2",
          migration_count: "1",
        },
      ]);
      expect(snapshots.sharedSnapshotId).not.toBe(
        snapshots.quarantinedSnapshotId,
      );
    } finally {
      await database.close();
      await rm(legacyMigrations, { recursive: true, force: true });
    }
  }, 120_000);

  it("distinguishes exact legacy totals from corruption before and after reconciliation", async () => {
    const database = await createTestDatabase();
    const legacyMigrations = await copyMigrationsThrough009();
    try {
      await runMigrations(database.pool, legacyMigrations);
      await insertLegacyVerifiedSnapshot(database.pool);
      const accountId = randomUUID();
      await database.pool.query(
        `INSERT INTO accounts (id,status) VALUES ($1,'active')`,
        [accountId],
      );
      await database.pool.query(
        `INSERT INTO api_keys (
           id,account_id,public_id,secret_digest
         ) VALUES ($1,$2,$3,$4)`,
        [randomUUID(), accountId, "fixturepublicid1", Buffer.alloc(32, 1)],
      );

      const before = await readFixtureEvidence(database.pool, accountId);
      expect(before.catalog).toMatchObject({
        legacySnapshotByteTotals: 1,
        invalidSnapshotByteTotals: 0,
        invalidSnapshotByteOverflows: 0,
        invalidSnapshotObjectGraph: 0,
        invalidRevisionHashes: 0,
        invalidSnapshotReconciliations: 0,
      });
      const expected009 = await expectedMigrationInventory(
        legacyMigrations,
        "009",
      );
      expect(() =>
        assessRestoredDatabaseEvidence(
          { ...before, currentDatabase: "skillwire" },
          {
            expectedMigrations: expected009,
            installationAccountId: accountId,
            expectedActiveApiKeys: 1,
            expectedDatabase: "skillwire",
            expectedState: databaseStateExpectation(before),
          },
        ),
      ).not.toThrow();

      await runMigrations(database.pool);
      const after = await readFixtureEvidence(database.pool, accountId);
      expect(after.catalog).toMatchObject({
        legacySnapshotByteTotals: 0,
        invalidSnapshotByteTotals: 0,
        invalidSnapshotByteOverflows: 0,
        invalidSnapshotObjectGraph: 0,
        invalidRevisionHashes: 0,
        invalidSnapshotReconciliations: 0,
      });
      const expected011 = await expectedMigrationInventory(
        join(process.cwd(), "migrations"),
        "011",
      );
      expect(() =>
        assessRestoredDatabaseEvidence(
          { ...after, currentDatabase: "skillwire" },
          {
            expectedMigrations: expected011,
            installationAccountId: accountId,
            expectedActiveApiKeys: 1,
            expectedDatabase: "skillwire",
            expectedState: forwardMigrationStateExpectation(before, after),
          },
        ),
      ).not.toThrow();
      const sourceConstraint = before.constraints[0];
      expect(sourceConstraint).toBeDefined();
      expect(() =>
        forwardMigrationStateExpectation(before, {
          ...after,
          constraints: after.constraints.map((constraint) =>
            constraint.constraintName === sourceConstraint?.constraintName
              ? { ...constraint, validated: false }
              : constraint,
          ),
        }),
      ).toThrow(/changed pre-existing constraint/i);
      await database.pool.query(
        `ALTER TABLE external_snapshot_byte_total_reconciliations
           DISABLE TRIGGER external_snapshot_byte_total_reconciliations_immutable`,
      );
      await database.pool.query(
        "DELETE FROM external_snapshot_byte_total_reconciliations",
      );
      await database.pool.query(
        `ALTER TABLE external_snapshot_byte_total_reconciliations
           ENABLE TRIGGER external_snapshot_byte_total_reconciliations_immutable`,
      );
      const corrupted = await readFixtureEvidence(database.pool, accountId);
      expect(corrupted.catalog.invalidSnapshotReconciliations).toBe(1);
    } finally {
      await database.close();
      await rm(legacyMigrations, { recursive: true, force: true });
    }
  }, 120_000);

  it("reconciles an exact pre-v0.2.0 payload total to canonical bytes", async () => {
    const database = await createTestDatabase();
    const legacyMigrations = await copyMigrationsThrough009();
    try {
      await runMigrations(database.pool, legacyMigrations);
      const fixture = await insertLegacyVerifiedSnapshot(database.pool);

      await runMigrations(database.pool);

      const result = await database.pool.query<{
        latest_migration: string;
        prior_decoded_bytes: string;
        reconciled_decoded_bytes: string;
        stored_decoded_bytes: string;
      }>(
        `SELECT
           (SELECT max(version) FROM schema_migrations) AS latest_migration,
           reconciliation.prior_decoded_bytes::text,
           reconciliation.reconciled_decoded_bytes::text,
           snapshot.decoded_bytes::text AS stored_decoded_bytes
         FROM external_source_snapshots snapshot
         JOIN external_snapshot_byte_total_reconciliations reconciliation
           ON reconciliation.snapshot_id=snapshot.id
         WHERE snapshot.id=$1`,
        [fixture.snapshotId],
      );
      expect(result.rows).toEqual([
        {
          latest_migration: "011",
          prior_decoded_bytes: String(fixture.legacyByteTotal),
          reconciled_decoded_bytes: String(fixture.canonicalByteTotal),
          stored_decoded_bytes: String(fixture.canonicalByteTotal),
        },
      ]);
    } finally {
      await database.close();
      await rm(legacyMigrations, { recursive: true, force: true });
    }
  }, 120_000);
});
