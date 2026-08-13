import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../../src/persistence/postgres/migration-runner.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

async function copyMigrationsThrough009(): Promise<string> {
  const source = join(process.cwd(), "migrations");
  const target = await mkdtemp(join(tmpdir(), "skillwire-migrations-009-"));
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

interface HistoricalRevisionFixture {
  readonly candidateId: string;
  readonly identityId: string;
  readonly reportId: string;
  readonly revisionId: string;
  readonly terminalEventId: string;
}

async function insertHistoricalRevision(
  pool: Pool,
  sourceId: string,
  classification: "verified" | "quarantined" | "curated",
  ordinal: number,
): Promise<HistoricalRevisionFixture> {
  const snapshotId = randomUUID();
  const identityId = randomUUID();
  const revisionId = randomUUID();
  const candidateId = randomUUID();
  const reportId = randomUUID();
  const discoveredEventId = randomUUID();
  const verifiedEventId = randomUUID();
  const terminalEventId =
    classification === "curated" ? randomUUID() : verifiedEventId;
  const key = ordinal.toString(16);
  const root = `${classification}-${String(ordinal)}`;
  await pool.query(
    `INSERT INTO external_source_snapshots (
       id,source_id,commit_sha,tree_sha,manifest_version,revision_count,
       advisory_chain_head_sha256,origin_github_repository_id,
       origin_owner,origin_repository
     ) VALUES ($1,$2,$3,$4,'nested-v1',1,$5,7002,'fixture-org',
               'migration-shapes')`,
    [
      snapshotId,
      sourceId,
      key.repeat(40),
      ((ordinal + 8) % 16).toString(16).repeat(40),
      "0".repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO external_skill_identities (
       id,source_id,catalog_skill_id,normalized_skill_root
     ) VALUES ($1,$2,$3,$4)`,
    [identityId, sourceId, `${root}-skill`, root],
  );
  await pool.query(
    `INSERT INTO external_skill_revisions (
       id,skill_identity_id,snapshot_id,revision,bundle_sha256,
       content_identity_sha256,name,description,skill_path,commit_sha,
       source_owner,spdx_license_id,license_sha256,instructions_sha256,
       invocation_mode,canonical_bytes,origin_owner,origin_repository
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'Migration shape fixture.',$8,$9,
               'Fixture Owner','MIT',$10,$11,'automatic','{}',
               'fixture-org','migration-shapes')`,
    [
      revisionId,
      identityId,
      snapshotId,
      `gh-${key.repeat(64)}`,
      ((ordinal + 1) % 16).toString(16).repeat(64),
      ((ordinal + 2) % 16).toString(16).repeat(64),
      `${root}-skill`,
      `${root}/SKILL.md`,
      key.repeat(40),
      "e".repeat(64),
      "f".repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO external_import_candidates (
       id,snapshot_id,skill_identity_id,published_revision_id,adapter_kind,
       normalized_skill_root,normalized_name,display_name,description,
       skill_document_path,source_path_sha256
     ) VALUES ($1,$2,$3,$4,'nested-skill',$5,$6,$6,
               'Migration shape fixture.',$7,$8)`,
    [
      candidateId,
      snapshotId,
      identityId,
      revisionId,
      root,
      `${root}-skill`,
      `${root}/SKILL.md`,
      ((ordinal + 3) % 16).toString(16).repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO external_verification_reports (
       id,candidate_id,policy_version,validator_version,input_sha256,
       report_sha256,result
     ) VALUES ($1,$2,'external-policy-v1','external-validator-v1',$3,$4,$5)`,
    [
      reportId,
      candidateId,
      ((ordinal + 4) % 16).toString(16).repeat(64),
      ((ordinal + 5) % 16).toString(16).repeat(64),
      classification === "quarantined" ? "failed" : "passed",
    ],
  );
  await pool.query(
    `INSERT INTO external_classification_events (
       id,candidate_id,previous_classification,next_classification,
       actor_kind,actor_id,reason_code,report_id
     ) VALUES
       ($1,$3,NULL,'discovered','synchronization','legacy-sync',
        'CANDIDATE_DISCOVERED',NULL),
       ($2,$3,'discovered',$4,'verifier','legacy-verifier',$5,$6)`,
    [
      discoveredEventId,
      verifiedEventId,
      candidateId,
      classification === "quarantined" ? "quarantined" : "verified",
      classification === "quarantined"
        ? "SKILL_SCHEMA_INVALID"
        : "AUTOMATIC_VERIFICATION_PASSED",
      reportId,
    ],
  );
  if (classification === "curated") {
    await pool.query(
      `INSERT INTO external_classification_events (
         id,candidate_id,previous_classification,next_classification,
         actor_kind,actor_id,reason_code,report_id
       ) VALUES ($1,$2,'verified','curated','administrator','legacy-admin',
                 'ADMIN_CURATED',NULL)`,
      [terminalEventId, candidateId],
    );
    await pool.query(
      `INSERT INTO external_curation_decisions (
         id,classification_event_id,administrator_id,reason_code
       ) VALUES ($1,$2,'legacy-admin','ADMIN_CURATED')`,
      [randomUUID(), terminalEventId],
    );
  }
  await pool.query(
    `INSERT INTO external_current_classifications (
       candidate_id,classification,latest_event_id,updated_at
     ) VALUES ($1,$2,$3,'2000-01-01 00:00:00+00')`,
    [candidateId, classification, terminalEventId],
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
      ((ordinal + 2) % 16).toString(16).repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO external_current_revision_classifications (
       revision_id,classification,latest_event_id,updated_at
     ) VALUES ($1,$2,$3,'2000-01-01 00:00:00+00')`,
    [revisionId, classification, terminalEventId],
  );
  return { candidateId, identityId, reportId, revisionId, terminalEventId };
}

async function insertHistoricalSibling(
  pool: Pool,
  sourceId: string,
  fixture: HistoricalRevisionFixture,
): Promise<{ readonly candidateId: string; readonly terminalEventId: string }> {
  const snapshotId = randomUUID();
  const candidateId = randomUUID();
  const reportId = randomUUID();
  const discoveredEventId = randomUUID();
  const terminalEventId = randomUUID();
  await pool.query(
    `INSERT INTO external_source_snapshots (
       id,source_id,commit_sha,tree_sha,manifest_version,revision_count,
       advisory_chain_head_sha256,origin_github_repository_id,
       origin_owner,origin_repository
     ) VALUES ($1,$2,$3,$4,'nested-v1',1,$5,7002,'fixture-org',
               'migration-shapes')`,
    [snapshotId, sourceId, "a".repeat(40), "b".repeat(40), "0".repeat(64)],
  );
  await pool.query(
    `INSERT INTO external_import_candidates (
       id,snapshot_id,skill_identity_id,published_revision_id,adapter_kind,
       normalized_skill_root,normalized_name,display_name,description,
       skill_document_path,source_path_sha256
     )
     SELECT $1,$2,skill_identity_id,id,'nested-skill','verified-1',name,name,
            'Migration sibling fixture.',skill_path,$4
     FROM external_skill_revisions WHERE id=$3`,
    [candidateId, snapshotId, fixture.revisionId, "c".repeat(64)],
  );
  await pool.query(
    `INSERT INTO external_verification_reports (
       id,candidate_id,policy_version,validator_version,input_sha256,
       report_sha256,result
     ) VALUES ($1,$2,'external-policy-v1','external-validator-v1',$3,$4,
               'passed')`,
    [reportId, candidateId, "d".repeat(64), "e".repeat(64)],
  );
  await pool.query(
    `INSERT INTO external_classification_events (
       id,candidate_id,previous_classification,next_classification,
       actor_kind,actor_id,reason_code,report_id
     ) VALUES
       ($1,$3,NULL,'discovered','synchronization','legacy-sync',
        'CANDIDATE_DISCOVERED',NULL),
       ($2,$3,'discovered','verified','verifier','legacy-verifier',
        'AUTOMATIC_VERIFICATION_PASSED',$4)`,
    [discoveredEventId, terminalEventId, candidateId, reportId],
  );
  await pool.query(
    `INSERT INTO external_current_classifications (
       candidate_id,classification,latest_event_id,updated_at
     ) VALUES ($1,'verified',$2,'2000-01-02 00:00:00+00')`,
    [candidateId, terminalEventId],
  );
  await pool.query(
    `INSERT INTO external_snapshot_skill_observations (
       snapshot_id,skill_identity_id,revision_id,result,candidate_id,
       observed_content_identity_sha256
     )
     SELECT $1,skill_identity_id,id,'reused',$2,content_identity_sha256
     FROM external_skill_revisions WHERE id=$3`,
    [snapshotId, candidateId, fixture.revisionId],
  );
  await pool.query(
    `UPDATE external_current_revision_classifications
     SET latest_event_id=$2,updated_at='2000-01-02 00:00:00+00'
     WHERE revision_id=$1`,
    [fixture.revisionId, terminalEventId],
  );
  return { candidateId, terminalEventId };
}

async function insertUnobservedHistoricalCandidate(
  pool: Pool,
  sourceId: string,
  fixture: HistoricalRevisionFixture,
): Promise<string> {
  const snapshotId = randomUUID();
  const candidateId = randomUUID();
  const reportId = randomUUID();
  const discoveredEventId = randomUUID();
  const verifiedEventId = randomUUID();
  await pool.query(
    `INSERT INTO external_source_snapshots (
       id,source_id,commit_sha,tree_sha,manifest_version,revision_count,
       advisory_chain_head_sha256,origin_github_repository_id,
       origin_owner,origin_repository
     ) VALUES ($1,$2,$3,$4,'nested-v1',0,$5,7002,'fixture-org',
               'migration-shapes')`,
    [snapshotId, sourceId, "c".repeat(40), "d".repeat(40), "0".repeat(64)],
  );
  await pool.query(
    `INSERT INTO external_import_candidates (
       id,snapshot_id,skill_identity_id,published_revision_id,adapter_kind,
       normalized_skill_root,normalized_name,display_name,description,
       skill_document_path,source_path_sha256
     )
     SELECT $1,$2,skill_identity_id,id,'nested-skill','unobserved',name,name,
            'Malformed historical candidate.',skill_path,$4
     FROM external_skill_revisions WHERE id=$3`,
    [candidateId, snapshotId, fixture.revisionId, "f".repeat(64)],
  );
  await pool.query(
    `INSERT INTO external_verification_reports (
       id,candidate_id,policy_version,validator_version,input_sha256,
       report_sha256,result
     ) VALUES ($1,$2,'external-policy-v1','external-validator-v1',$3,$4,
               'passed')`,
    [reportId, candidateId, "1".repeat(64), "2".repeat(64)],
  );
  await pool.query(
    `INSERT INTO external_classification_events (
       id,candidate_id,previous_classification,next_classification,
       actor_kind,actor_id,reason_code,report_id
     ) VALUES
       ($1,$3,NULL,'discovered','synchronization','legacy-sync',
        'CANDIDATE_DISCOVERED',NULL),
       ($2,$3,'discovered','verified','verifier','legacy-verifier',
        'AUTOMATIC_VERIFICATION_PASSED',$4)`,
    [discoveredEventId, verifiedEventId, candidateId, reportId],
  );
  await pool.query(
    `INSERT INTO external_current_classifications (
       candidate_id,classification,latest_event_id
     ) VALUES ($1,'verified',$2)`,
    [candidateId, verifiedEventId],
  );
  await pool.query(
    `UPDATE external_current_revision_classifications
     SET latest_event_id=$2 WHERE revision_id=$1`,
    [fixture.revisionId, verifiedEventId],
  );
  return candidateId;
}

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
    expect(versions.rows.at(-1)?.version).toBe("010");
    const required = [
      "github_discovery_runs",
      "github_discovery_evidence",
      "github_job_leases",
      "external_import_candidates",
      "external_verification_reports",
      "external_validation_findings",
      "external_classification_events",
      "external_revision_classification_events",
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

  it("backfills one typed revision baseline and preserves candidate history", async () => {
    const legacy = await createTestDatabase();
    const source = join(process.cwd(), "migrations");
    const prefix = await mkdtemp(join(tmpdir(), "skillwire-migrations-009-"));
    try {
      for (const name of (await readdir(source)).filter((name) =>
        /^00[1-9]_.*\.sql$/.test(name),
      )) {
        await writeFile(
          join(prefix, name),
          await readFile(join(source, name), "utf8"),
        );
      }
      await runMigrations(legacy.pool, prefix);

      const sourceId = randomUUID();
      const snapshotId = randomUUID();
      const identityId = randomUUID();
      const revisionId = randomUUID();
      const candidateId = randomUUID();
      const reportId = randomUUID();
      const discoveredEventId = randomUUID();
      const verifiedEventId = randomUUID();
      const curatedEventId = randomUUID();
      const instructionsSha256 = "1".repeat(64);
      const licenseSha256 = "2".repeat(64);
      const contentIdentitySha256 = "3".repeat(64);
      await legacy.pool.query(
        `INSERT INTO github_sources (
           id,github_repository_id,owner,repository,normalized_owner,
           normalized_repository,default_branch
         ) VALUES ($1,7001,'fixture-org','legacy-events','fixture-org',
                   'legacy-events','main')`,
        [sourceId],
      );
      await legacy.pool.query(
        `INSERT INTO external_source_snapshots (
           id,source_id,commit_sha,tree_sha,manifest_version,revision_count,
           advisory_chain_head_sha256,origin_github_repository_id,
           origin_owner,origin_repository
         ) VALUES ($1,$2,$3,$4,'nested-v1',1,$5,7001,'fixture-org',
                   'legacy-events')`,
        [snapshotId, sourceId, "a".repeat(40), "b".repeat(40), "0".repeat(64)],
      );
      await legacy.pool.query(
        `INSERT INTO external_content_objects (
           sha256,kind,media_type,byte_length,content
         ) VALUES ($1,'instructions','text/markdown',2,'ok'),
                  ($2,'license','text/plain',3,'MIT')`,
        [instructionsSha256, licenseSha256],
      );
      await legacy.pool.query(
        `INSERT INTO external_skill_identities (
           id,source_id,catalog_skill_id,normalized_skill_root
         ) VALUES ($1,$2,'legacy-event-skill','legacy')`,
        [identityId, sourceId],
      );
      await legacy.pool.query(
        `INSERT INTO external_skill_revisions (
           id,skill_identity_id,snapshot_id,revision,bundle_sha256,
           content_identity_sha256,name,description,skill_path,commit_sha,
           source_owner,spdx_license_id,license_sha256,instructions_sha256,
           invocation_mode,canonical_bytes,origin_owner,origin_repository
         ) VALUES ($1,$2,$3,$4,$5,$6,'legacy-event-skill',
                   'Legacy migration fixture.','legacy/SKILL.md',$7,
                   'Fixture Owner','MIT',$8,$9,'automatic','{}',
                   'fixture-org','legacy-events')`,
        [
          revisionId,
          identityId,
          snapshotId,
          `gh-${"4".repeat(64)}`,
          "5".repeat(64),
          contentIdentitySha256,
          "a".repeat(40),
          licenseSha256,
          instructionsSha256,
        ],
      );
      await legacy.pool.query(
        `INSERT INTO external_import_candidates (
           id,snapshot_id,skill_identity_id,published_revision_id,adapter_kind,
           normalized_skill_root,normalized_name,display_name,description,
           skill_document_path,source_path_sha256
         ) VALUES ($1,$2,$3,$4,'nested-skill','legacy','legacy-event-skill',
                   'legacy-event-skill','Legacy migration fixture.',
                   'legacy/SKILL.md',$5)`,
        [candidateId, snapshotId, identityId, revisionId, "6".repeat(64)],
      );
      await legacy.pool.query(
        `INSERT INTO external_verification_reports (
           id,candidate_id,policy_version,validator_version,input_sha256,
           report_sha256,result
         ) VALUES ($1,$2,'external-policy-v1','external-validator-v1',$3,$4,
                   'passed')`,
        [reportId, candidateId, "7".repeat(64), "8".repeat(64)],
      );
      await legacy.pool.query(
        `INSERT INTO external_classification_events (
           id,candidate_id,previous_classification,next_classification,
           actor_kind,actor_id,reason_code,report_id
         ) VALUES
           ($1,$4,NULL,'discovered','synchronization','legacy-sync',
            'CANDIDATE_DISCOVERED',NULL),
           ($2,$4,'discovered','verified','verifier','legacy-verifier',
            'AUTOMATIC_VERIFICATION_PASSED',$5),
           ($3,$4,'verified','curated','administrator','legacy-admin',
            'ADMIN_CURATED',NULL)`,
        [
          discoveredEventId,
          verifiedEventId,
          curatedEventId,
          candidateId,
          reportId,
        ],
      );
      await legacy.pool.query(
        `INSERT INTO external_current_classifications (
           candidate_id,classification,latest_event_id
         ) VALUES ($1,'curated',$2)`,
        [candidateId, curatedEventId],
      );
      await legacy.pool.query(
        `INSERT INTO external_snapshot_skill_observations (
           snapshot_id,skill_identity_id,revision_id,result,candidate_id,
           observed_content_identity_sha256
         ) VALUES ($1,$2,$3,'published',$4,$5)`,
        [
          snapshotId,
          identityId,
          revisionId,
          candidateId,
          contentIdentitySha256,
        ],
      );
      await legacy.pool.query(
        `INSERT INTO external_current_revision_classifications (
           revision_id,classification,latest_event_id
         ) VALUES ($1,'curated',$2)`,
        [revisionId, curatedEventId],
      );
      await legacy.pool.query(
        `INSERT INTO external_curation_decisions (
           id,classification_event_id,administrator_id,reason_code
         ) VALUES ($1,$2,'legacy-admin','ADMIN_CURATED')`,
        [randomUUID(), curatedEventId],
      );

      await runMigrations(legacy.pool);
      await runMigrations(legacy.pool);

      const baseline = await legacy.pool.query<{
        revision_id: string;
        initiating_candidate_id: string;
        previous_classification: string | null;
        next_classification: string;
        actor_id: string;
        reason_code: string;
      }>(
        `SELECT revision_id,initiating_candidate_id,previous_classification,
                next_classification,actor_id,reason_code
         FROM external_revision_classification_events`,
      );
      expect(baseline.rows).toEqual([
        {
          revision_id: revisionId,
          initiating_candidate_id: candidateId,
          previous_classification: null,
          next_classification: "curated",
          actor_id: "migration-010",
          reason_code: "REVISION_CLASSIFICATION_BACKFILLED",
        },
      ]);
      expect(
        (
          await legacy.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM external_classification_events
             WHERE candidate_id=$1`,
            [candidateId],
          )
        ).rows[0]?.count,
      ).toBe("3");
      expect(
        (
          await legacy.pool.query<{
            classification_event_id: string | null;
            revision_classification_event_id: string | null;
          }>(
            `SELECT classification_event_id,revision_classification_event_id
             FROM external_curation_decisions`,
          )
        ).rows,
      ).toEqual([
        {
          classification_event_id: curatedEventId,
          revision_classification_event_id: null,
        },
      ]);
      const current = await legacy.pool.query<{
        classification: string;
        event_revision_id: string;
        event_classification: string;
      }>(
        `SELECT current.classification,event.revision_id AS event_revision_id,
                event.next_classification AS event_classification
         FROM external_current_revision_classifications current
         JOIN external_revision_classification_events event
           ON event.id=current.latest_event_id
         WHERE current.revision_id=$1`,
        [revisionId],
      );
      expect(current.rows).toEqual([
        {
          classification: "curated",
          event_revision_id: revisionId,
          event_classification: "curated",
        },
      ]);
      await expect(
        legacy.pool.query(
          `UPDATE external_current_revision_classifications
           SET latest_event_id=$2 WHERE revision_id=$1`,
          [revisionId, curatedEventId],
        ),
      ).rejects.toThrow();
      await expect(
        legacy.pool.query(
          `UPDATE external_revision_classification_events
           SET reason_code='CHANGED' WHERE revision_id=$1`,
          [revisionId],
        ),
      ).rejects.toThrow(/immutable/i);

      const unrelatedCandidateId = randomUUID();
      const unrelatedDiscoveredEventId = randomUUID();
      await legacy.pool.query(
        `INSERT INTO external_import_candidates (
           id,snapshot_id,adapter_kind,normalized_skill_root,normalized_name,
           display_name,description,skill_document_path,source_path_sha256
         ) VALUES ($1,$2,'nested-skill','unrelated','unrelated-event-skill',
                   'unrelated-event-skill','Unrelated migration fixture.',
                   'unrelated/SKILL.md',$3)`,
        [unrelatedCandidateId, snapshotId, "9".repeat(64)],
      );
      await legacy.pool.query(
        `INSERT INTO external_classification_events (
           id,candidate_id,previous_classification,next_classification,
           actor_kind,actor_id,reason_code,report_id
         ) VALUES ($1,$2,NULL,'discovered','synchronization','legacy-sync',
                   'CANDIDATE_DISCOVERED',NULL)`,
        [unrelatedDiscoveredEventId, unrelatedCandidateId],
      );
      await legacy.pool.query(
        `INSERT INTO external_current_classifications (
           candidate_id,classification,latest_event_id
         ) VALUES ($1,'discovered',$2)`,
        [unrelatedCandidateId, unrelatedDiscoveredEventId],
      );
      await expect(
        legacy.pool.query(
          `UPDATE external_current_classifications
           SET classification='curated',latest_event_id=$2
           WHERE candidate_id=$1`,
          [unrelatedCandidateId, curatedEventId],
        ),
      ).rejects.toThrow();
      await expect(
        legacy.pool.query(
          `INSERT INTO external_revision_classification_events (
             id,revision_id,initiating_candidate_id,previous_classification,
             next_classification,actor_kind,actor_id,reason_code,report_id
           ) VALUES ($1,$2,$3,'curated','quarantined','administrator',
                     'legacy-admin','ADMIN_QUARANTINE',NULL)`,
          [randomUUID(), revisionId, unrelatedCandidateId],
        ),
      ).rejects.toThrow(/attribution mismatch/i);
    } finally {
      await legacy.close();
      await rm(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("upgrades every supported historical revision shape from one truthful baseline", async () => {
    const legacy = await createTestDatabase();
    const prefix = await copyMigrationsThrough009();
    try {
      await runMigrations(legacy.pool, prefix);
      const sourceId = randomUUID();
      await legacy.pool.query(
        `INSERT INTO github_sources (
           id,github_repository_id,owner,repository,normalized_owner,
           normalized_repository,default_branch
         ) VALUES ($1,7002,'fixture-org','migration-shapes','fixture-org',
                   'migration-shapes','main')`,
        [sourceId],
      );
      await legacy.pool.query(
        `INSERT INTO external_content_objects (
           sha256,kind,media_type,byte_length,content
         ) VALUES ($1,'license','text/plain',3,'MIT'),
                  ($2,'instructions','text/markdown',2,'ok')`,
        ["e".repeat(64), "f".repeat(64)],
      );
      const verified = await insertHistoricalRevision(
        legacy.pool,
        sourceId,
        "verified",
        1,
      );
      const quarantined = await insertHistoricalRevision(
        legacy.pool,
        sourceId,
        "quarantined",
        2,
      );
      const curated = await insertHistoricalRevision(
        legacy.pool,
        sourceId,
        "curated",
        3,
      );
      const sibling = await insertHistoricalSibling(
        legacy.pool,
        sourceId,
        verified,
      );
      const candidateEventCount = await legacy.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM external_classification_events",
      );
      const beforeMigration = await legacy.pool.query<{ observed_at: Date }>(
        "SELECT clock_timestamp() AS observed_at",
      );

      await runMigrations(legacy.pool);
      await runMigrations(legacy.pool);

      const baselines = await legacy.pool.query<{
        actor_id: string;
        classification: string;
        created_at: Date;
        initiating_candidate_id: string;
        reason_code: string;
        report_id: string | null;
        revision_id: string;
      }>(
        `SELECT revision_id,initiating_candidate_id,
                next_classification AS classification,actor_id,
                reason_code,report_id,created_at
         FROM external_revision_classification_events
         WHERE reason_code='REVISION_CLASSIFICATION_BACKFILLED'
         ORDER BY revision_id`,
      );
      expect(baselines.rows).toHaveLength(3);
      expect(
        baselines.rows.map(({ classification }) => classification).toSorted(),
      ).toEqual(["curated", "quarantined", "verified"]);
      expect(
        baselines.rows.every(
          ({ actor_id, reason_code, report_id }) =>
            actor_id === "migration-010" &&
            reason_code === "REVISION_CLASSIFICATION_BACKFILLED" &&
            report_id === null,
        ),
      ).toBe(true);
      const migrationStartedAfter = beforeMigration.rows[0]?.observed_at;
      if (migrationStartedAfter === undefined) {
        throw new Error("migration timestamp boundary missing");
      }
      expect(
        baselines.rows.every(
          ({ created_at }) => created_at >= migrationStartedAfter,
        ),
      ).toBe(true);
      expect(
        new Set(
          baselines.rows.map(({ created_at }) => created_at.toISOString()),
        ).size,
      ).toBe(1);
      expect(
        baselines.rows.find(
          ({ revision_id }) => revision_id === verified.revisionId,
        )?.initiating_candidate_id,
      ).toBe(sibling.candidateId);
      const baselineIntegrity = await legacy.pool.query<{
        baseline_count: string;
        current_count: string;
        referenced_baseline_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM external_revision_classification_events
            WHERE reason_code='REVISION_CLASSIFICATION_BACKFILLED')
             AS baseline_count,
           (SELECT count(*)::text FROM external_current_revision_classifications)
             AS current_count,
           (SELECT count(*)::text
            FROM external_current_revision_classifications current
            JOIN external_revision_classification_events event
              ON event.id=current.latest_event_id
             AND event.revision_id=current.revision_id
             AND event.next_classification=current.classification
            WHERE event.reason_code='REVISION_CLASSIFICATION_BACKFILLED')
             AS referenced_baseline_count`,
      );
      expect(baselineIntegrity.rows).toEqual([
        {
          baseline_count: "3",
          current_count: "3",
          referenced_baseline_count: "3",
        },
      ]);
      expect(
        (
          await legacy.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM external_classification_events",
          )
        ).rows[0]?.count,
      ).toBe(candidateEventCount.rows[0]?.count);
      expect(
        (
          await legacy.pool.query<{ classification: string }>(
            `SELECT classification FROM external_current_classifications
             WHERE candidate_id=ANY($1::uuid[]) ORDER BY candidate_id`,
            [[verified.candidateId, sibling.candidateId]],
          )
        ).rows,
      ).toEqual([
        { classification: "verified" },
        { classification: "verified" },
      ]);

      await expect(
        legacy.pool.query(
          `INSERT INTO external_revision_classification_events (
             id,revision_id,initiating_candidate_id,previous_classification,
             next_classification,actor_kind,actor_id,reason_code,report_id
           ) VALUES ($1,$2,$3,NULL,'verified','synchronization','migration-010',
                     'REVISION_CLASSIFICATION_BACKFILLED',NULL)`,
          [randomUUID(), verified.revisionId, sibling.candidateId],
        ),
      ).rejects.toThrow(/baseline|backfill/i);

      const quarantineEventId = randomUUID();
      const transitionClient = await legacy.pool.connect();
      try {
        await transitionClient.query("BEGIN");
        await transitionClient.query(
          `INSERT INTO external_revision_classification_events (
             id,revision_id,initiating_candidate_id,previous_classification,
             next_classification,actor_kind,actor_id,reason_code,report_id
           ) VALUES ($1,$2,$3,'verified','quarantined','administrator',
                     'post-migration-admin','ADMIN_QUARANTINE',NULL)`,
          [quarantineEventId, verified.revisionId, sibling.candidateId],
        );
        await transitionClient.query(
          `UPDATE external_current_revision_classifications
           SET classification='quarantined',latest_event_id=$2
           WHERE revision_id=$1`,
          [verified.revisionId, quarantineEventId],
        );
        const continuity = await transitionClient.query<{
          next_classification: string;
          previous_classification: string | null;
        }>(
          `SELECT previous_classification,next_classification
           FROM external_revision_classification_events
           WHERE revision_id=$1 ORDER BY created_at,id`,
          [verified.revisionId],
        );
        expect(continuity.rows).toEqual([
          { previous_classification: null, next_classification: "verified" },
          {
            previous_classification: "verified",
            next_classification: "quarantined",
          },
        ]);
      } finally {
        await transitionClient.query("ROLLBACK");
        transitionClient.release();
      }
      expect(
        new Set(baselines.rows.map(({ revision_id }) => revision_id)),
      ).toEqual(
        new Set([
          verified.revisionId,
          quarantined.revisionId,
          curated.revisionId,
        ]),
      );
    } finally {
      await legacy.close();
      await rm(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("rolls back migration 010 when historical revision attribution is malformed", async () => {
    const legacy = await createTestDatabase();
    const prefix = await copyMigrationsThrough009();
    try {
      await runMigrations(legacy.pool, prefix);
      const sourceId = randomUUID();
      await legacy.pool.query(
        `INSERT INTO github_sources (
           id,github_repository_id,owner,repository,normalized_owner,
           normalized_repository,default_branch
         ) VALUES ($1,7002,'fixture-org','migration-shapes','fixture-org',
                   'migration-shapes','main')`,
        [sourceId],
      );
      await legacy.pool.query(
        `INSERT INTO external_content_objects (
           sha256,kind,media_type,byte_length,content
         ) VALUES ($1,'license','text/plain',3,'MIT'),
                  ($2,'instructions','text/markdown',2,'ok')`,
        ["e".repeat(64), "f".repeat(64)],
      );
      const verified = await insertHistoricalRevision(
        legacy.pool,
        sourceId,
        "verified",
        4,
      );
      await insertUnobservedHistoricalCandidate(
        legacy.pool,
        sourceId,
        verified,
      );

      await expect(runMigrations(legacy.pool)).rejects.toThrow(
        /candidate attribution mismatch/i,
      );
      expect(
        (
          await legacy.pool.query<{
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
      expect(
        (
          await legacy.pool.query<{ classification: string }>(
            `SELECT classification
             FROM external_current_revision_classifications
             WHERE revision_id=$1`,
            [verified.revisionId],
          )
        ).rows,
      ).toEqual([{ classification: "verified" }]);

      const pre010EventId = randomUUID();
      await legacy.pool.query(
        `INSERT INTO external_classification_events (
           id,candidate_id,previous_classification,next_classification,
           actor_kind,actor_id,reason_code,report_id
         ) VALUES ($1,$2,'verified','quarantined','administrator',
                   'pre-010-rollback-check','ADMIN_QUARANTINE',NULL)`,
        [pre010EventId, verified.candidateId],
      );
      await legacy.pool.query(
        `UPDATE external_current_classifications
         SET classification='quarantined',latest_event_id=$2
         WHERE candidate_id=$1`,
        [verified.candidateId, pre010EventId],
      );
      await legacy.pool.query(
        `UPDATE external_current_revision_classifications
         SET classification='quarantined',latest_event_id=$2
         WHERE revision_id=$1`,
        [verified.revisionId, pre010EventId],
      );
      expect(
        (
          await legacy.pool.query<{ classification: string }>(
            `SELECT classification
             FROM external_current_revision_classifications
             WHERE revision_id=$1`,
            [verified.revisionId],
          )
        ).rows,
      ).toEqual([{ classification: "quarantined" }]);
    } finally {
      await legacy.close();
      await rm(prefix, { recursive: true, force: true });
    }
  }, 120_000);
});
