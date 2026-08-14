import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import type {
  ConditionalRepositoryResult,
  GitHubSourceProvider,
  OperationContext,
} from "../../../src/application/ports/github-source-provider.js";
import { SourceRegistrationService } from "../../../src/application/services/source-registration-service.js";
import { SourceSynchronizationService } from "../../../src/application/services/source-synchronization-service.js";
import type {
  GitHubRepositoryCoordinate,
  GitHubRepositoryIdentity,
  GitHubRepositorySnapshot,
  GitTreeEntry,
} from "../../../src/domain/external-catalog/types.js";
import { PostgresExternalCatalogStore } from "../../../src/persistence/postgres/external-catalog-store.js";
import { PostgresGitHubSourceStore } from "../../../src/persistence/postgres/github-source-store.js";
import { PostgresImportedSkillCatalogProvider } from "../../../src/persistence/postgres/imported-skill-catalog-provider.js";
import { PostgresSyncLeaseStore } from "../../../src/persistence/postgres/sync-lease-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

const LICENSE = `MIT License

Copyright 2026 Fixture Owner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files.
`;

function skill(
  name: string,
  body: string,
  dependencies: readonly string[] = [],
): string {
  const dependencyYaml =
    dependencies.length === 0
      ? ""
      : `dependencies:\n${dependencies.map((value) => `  - ${value}\n`).join("")}`;
  return `---\nname: ${name}\ndescription: ${name} fixture.\n${dependencyYaml}---\n${body}\n`;
}

interface FixtureCommit {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly snapshot: GitHubRepositorySnapshot;
}

class MutableNestedFixtureProvider implements GitHubSourceProvider {
  readonly repositoryId: number;
  readonly repositoryName: string;
  readonly #blobs = new Map<string, Uint8Array>();
  readonly #commits: FixtureCommit[];
  index = 0;
  renamed = false;
  abortOnNextBlob: AbortController | undefined;
  beforeNextSnapshot: (() => Promise<void>) | undefined;
  metadataConditionalCalls = 0;
  metadataNotModified = 0;
  readonly exactCommitReads: string[] = [];
  #sequence = 1;

  constructor(
    repositoryId = 2002,
    private readonly licenseText: string | null = LICENSE,
  ) {
    this.repositoryId = repositoryId;
    this.repositoryName =
      repositoryId === 2002
        ? "nested-skills"
        : `nested-skills-${String(repositoryId)}`;
    this.#commits = [
      this.#commit("1".repeat(40), {
        "alpha/SKILL.md": skill("alpha", "Keep this content."),
        "beta/SKILL.md": skill("beta", "Old beta content."),
        "omega/SKILL.md": skill("omega", "Removed later."),
      }),
      this.#commit("2".repeat(40), {
        "alpha/SKILL.md": skill("alpha", "Keep this content."),
        "beta/SKILL.md": skill("beta", "Changed beta content."),
        "gamma/SKILL.md": skill("gamma", "New gamma content."),
        "broken/SKILL.md": skill("broken", "Missing dependency.", [
          "absent-skill",
        ]),
      }),
      this.#commit("3".repeat(40), {
        "alpha/SKILL.md": skill("alpha", "Keep this content."),
        "beta/SKILL.md": skill("beta", "Changed beta again."),
        "gamma/SKILL.md": skill("gamma", "New gamma content."),
      }),
      this.#commit("4".repeat(40), {
        "alpha/SKILL.md": skill("alpha", "Keep this content."),
        "beta/SKILL.md": skill("beta", "Changed beta once more."),
        "gamma/SKILL.md": skill("gamma", "New gamma content."),
      }),
      this.#commit("5".repeat(40), {
        "alpha/SKILL.md": skill("alpha", "Keep this content."),
      }),
      this.#commit("6".repeat(40), {
        "alpha/SKILL.md": "invalid skill document",
        "beta/SKILL.md": "invalid skill document",
        "omega/SKILL.md": "invalid skill document",
      }),
      this.#commit("7".repeat(40), {
        "alpha/SKILL.md": "invalid skill document",
        "beta/SKILL.md": skill("beta", "Changed beta content."),
        "omega/SKILL.md": skill("omega", "Removed later."),
      }),
    ];
  }

  resolvePublicRepository(
    _coordinate: GitHubRepositoryCoordinate,
    _context?: OperationContext,
  ): Promise<GitHubRepositoryIdentity> {
    return Promise.resolve({
      repositoryId: this.repositoryId,
      owner: this.renamed ? "fixture-renamed" : "fixture-org",
      repository: this.repositoryName,
      defaultBranch: "main",
    });
  }

  async resolvePublicRepositoryConditionally(
    coordinate: GitHubRepositoryCoordinate,
    etag: string | undefined,
    context?: OperationContext,
  ): Promise<ConditionalRepositoryResult> {
    this.metadataConditionalCalls += 1;
    const currentEtag = this.renamed ? '"repository-v2"' : '"repository-v1"';
    if (etag === currentEtag) {
      this.metadataNotModified += 1;
      return { etag, notModified: true };
    }
    return {
      repository: await this.resolvePublicRepository(coordinate, context),
      etag: currentEtag,
      notModified: false,
    };
  }

  async readDefaultSnapshot(
    repository: GitHubRepositoryIdentity,
    _context?: OperationContext,
  ): Promise<GitHubRepositorySnapshot> {
    const before = this.beforeNextSnapshot;
    this.beforeNextSnapshot = undefined;
    await before?.();
    const fixture = this.#commits[this.index];
    if (fixture === undefined) throw new Error("fixture commit missing");
    return Promise.resolve({ ...fixture.snapshot, repository });
  }

  readSnapshotAtCommit(
    repository: GitHubRepositoryIdentity,
    commitSha: string,
    _context?: OperationContext,
  ): Promise<GitHubRepositorySnapshot> {
    this.exactCommitReads.push(commitSha);
    const fixture = this.#commits.find(
      ({ commitSha: candidate }) => candidate === commitSha,
    );
    if (fixture === undefined) throw new Error("COMMIT_MISMATCH");
    return Promise.resolve({ ...fixture.snapshot, repository });
  }

  readBlob(
    _repository: GitHubRepositoryIdentity,
    sha: string,
    expectedSize: number,
    _context?: OperationContext,
  ): Promise<Uint8Array> {
    const value = this.#blobs.get(sha);
    if (value?.byteLength !== expectedSize) {
      throw new Error("HASH_MISMATCH");
    }
    const abort = this.abortOnNextBlob;
    this.abortOnNextBlob = undefined;
    abort?.abort(new DOMException("fixture cancellation", "AbortError"));
    return Promise.resolve(value);
  }

  #commit(
    commitSha: string,
    files: Readonly<Record<string, string>>,
  ): FixtureCommit {
    const allFiles =
      this.licenseText === null
        ? files
        : { LICENSE: this.licenseText, ...files };
    const tree: GitTreeEntry[] = Object.entries(allFiles).map(
      ([path, content]) => {
        const bytes = new TextEncoder().encode(content);
        const sha = createHash("sha1")
          .update(`blob ${String(bytes.byteLength)}\0`)
          .update(bytes)
          .digest("hex");
        this.#blobs.set(sha, bytes);
        return {
          path,
          mode: "100644",
          type: "blob",
          sha,
          size: bytes.byteLength,
        };
      },
    );
    const treeSha = this.#nextSha();
    return {
      commitSha,
      treeSha,
      snapshot: {
        repository: {
          repositoryId: this.repositoryId,
          owner: "fixture-org",
          repository: this.repositoryName,
          defaultBranch: "main",
        },
        commitSha,
        treeSha,
        tree,
      },
    };
  }

  #nextSha(): string {
    const value = this.#sequence.toString(16).padStart(40, "0");
    this.#sequence += 1;
    return value;
  }
}

async function waitForDatabaseLock(
  database: TestDatabase,
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const activity = await database.pool.query<{
      wait_event_type: string | null;
    }>(
      `SELECT wait_event_type FROM pg_stat_activity
       WHERE datname=current_database() AND application_name=$1`,
      [applicationName],
    );
    if (
      activity.rows.some(({ wait_event_type }) => wait_event_type === "Lock")
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`database lock wait not observed for ${applicationName}`);
}

describe("immutable source synchronization", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
  }, 120_000);

  it("keeps published provenance immutable through rename and reverifies the exact stored commit", async () => {
    const database = await createTestDatabase();
    await database.migrate();
    const provider = new MutableNestedFixtureProvider(6006);
    const store = new PostgresExternalCatalogStore(database.pool);
    const jobs = new PostgresGitHubSourceStore(database.pool);
    const leases = new PostgresSyncLeaseStore(database.pool);
    const registration = await new SourceRegistrationService(
      provider,
      store,
    ).add(
      { owner: "fixture-org", repository: provider.repositoryName },
      "rename-admin",
    );
    const synchronization = new SourceSynchronizationService(provider, store);
    const first = await synchronization.sync(registration.sourceId);
    const alpha = first.candidateTraces.find(
      ({ skillName }) => skillName === "alpha",
    );
    const alphaTrace = first.traces.find(
      ({ skillName }) => skillName === "alpha",
    );
    const omega = first.candidateTraces.find(
      ({ skillName }) => skillName === "omega",
    );
    if (alpha === undefined || alphaTrace === undefined || omega === undefined)
      throw new Error("alpha fixture missing");
    const before = await database.pool.query<{
      catalog_skill_id: string;
      canonical_bytes: string;
      origin_owner: string;
      origin_repository: string;
    }>(
      `SELECT i.catalog_skill_id,r.canonical_bytes,r.origin_owner,r.origin_repository
       FROM external_skill_revisions r
       JOIN external_skill_identities i ON i.id=r.skill_identity_id
       WHERE r.revision=$1`,
      [alphaTrace.revision],
    );

    provider.renamed = true;
    provider.index = 1;
    const anchoredHead = await store.advisoryChainHead();
    await database.pool.query(
      `UPDATE github_sources SET unavailable_confirmation_count=3,
         unavailable_first_observed_at=clock_timestamp()-interval '25 hours'
       WHERE id=$1`,
      [registration.sourceId],
    );
    await database.pool.query(
      `UPDATE github_source_aliases SET last_observed_at=clock_timestamp()-interval '26 hours'
       WHERE source_id=$1`,
      [registration.sourceId],
    );
    provider.beforeNextSnapshot = async () => {
      await store.recordSourceUnavailable(registration.sourceId, {
        authenticated: true,
        uncached: true,
        repositoryId: provider.repositoryId,
      });
    };
    await expect(synchronization.sync(registration.sourceId)).rejects.toThrow(
      "ADVISORY_CHAIN_STALE",
    );
    expect(await store.advisoryChainHead()).not.toBe(anchoredHead);
    expect(
      (
        await database.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM external_source_snapshots WHERE source_id=$1",
          [registration.sourceId],
        )
      ).rows[0]?.count,
    ).toBe("1");
    await synchronization.sync(registration.sourceId);
    const current = await database.pool.query<{
      owner: string;
      repository: string;
    }>("SELECT owner,repository FROM github_sources WHERE id=$1", [
      registration.sourceId,
    ]);
    expect(current.rows[0]).toEqual({
      owner: "fixture-renamed",
      repository: provider.repositoryName,
    });
    const after = await database.pool.query<{
      canonical_bytes: string;
      origin_owner: string;
      origin_repository: string;
    }>(
      `SELECT canonical_bytes,origin_owner,origin_repository
       FROM external_skill_revisions WHERE revision=$1`,
      [alphaTrace.revision],
    );
    expect(after.rows[0]).toEqual({
      canonical_bytes: before.rows[0]?.canonical_bytes,
      origin_owner: "fixture-org",
      origin_repository: provider.repositoryName,
    });
    const loaded = await new PostgresImportedSkillCatalogProvider(
      database.pool,
    ).findRevision(
      before.rows[0]?.catalog_skill_id ?? "missing",
      alphaTrace.revision,
    );
    expect(loaded?.catalogOrigin).toMatchObject({
      owner: "fixture-org",
      repository: provider.repositoryName,
      commitSha: "1".repeat(40),
    });

    await store.transitionCandidate(
      alpha.candidateId,
      "quarantined",
      "administrator",
      "rename-admin",
      "ADMIN_QUARANTINE",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const queued = await jobs.enqueueCandidateVerification(alpha.candidateId);
      expect(queued).toMatchObject({
        requestedCandidateId: alpha.candidateId,
        requestedCommitSha: "1".repeat(40),
        requestedRepository: {
          repositoryId: provider.repositoryId,
          owner: "fixture-org",
          repository: provider.repositoryName,
        },
      });
      if (attempt === 0) {
        await expect(
          jobs.enqueueCandidateVerification(omega.candidateId),
        ).rejects.toThrow("CONFLICT");
      }
      const run = (await jobs.claimQueuedSyncRuns(1))[0];
      if (run === undefined) throw new Error("verification run missing");
      const lease = await leases.acquire(
        `sync/${registration.sourceId}`,
        randomUUID(),
        10_000,
      );
      if (lease === undefined) throw new Error("verification lease missing");
      await jobs.markSyncRunning(run.runId, lease);
      const result = await synchronization.syncScheduled(
        run.sourceId,
        lease,
        {},
        run.requestedCommitSha,
        run.requestedRepository,
        run.requestedCandidateId,
      );
      await jobs.completeSyncRun(run.runId, lease, {
        commitSha: result.commitSha,
        treeSha: result.treeSha,
        candidates: result.candidateTraces.length,
        published: 0,
        reused: result.traces.length,
        quarantined: 0,
        resources: result.resourceCount,
        requests: 0,
        retries: 0,
        responseBytes: 0,
      });
      await leases.release(lease);
    }
    expect(provider.exactCommitReads).toEqual(["1".repeat(40), "1".repeat(40)]);
    expect(
      (
        await database.pool.query<{ classification: string }>(
          `SELECT classification FROM external_current_classifications
           WHERE candidate_id=$1`,
          [alpha.candidateId],
        )
      ).rows[0]?.classification,
    ).toBe("verified");
    expect(
      (
        await database.pool.query<{ owner: string }>(
          "SELECT owner FROM github_sources WHERE id=$1",
          [registration.sourceId],
        )
      ).rows[0]?.owner,
    ).toBe("fixture-renamed");
    await database.close();
  }, 120_000);

  afterAll(async () => database.close());

  it("restores a reused historical snapshot as the current source head", async () => {
    const isolated = await createTestDatabase();
    await isolated.migrate();
    try {
      const provider = new MutableNestedFixtureProvider(6011);
      const store = new PostgresExternalCatalogStore(isolated.pool);
      const registration = await new SourceRegistrationService(
        provider,
        store,
      ).add(
        { owner: "fixture-org", repository: provider.repositoryName },
        "historical-head-admin",
      );
      const synchronization = new SourceSynchronizationService(provider, store);
      const catalog = new PostgresImportedSkillCatalogProvider(isolated.pool);

      const first = await synchronization.sync(registration.sourceId);
      const firstMetadata = await catalog.listMetadata();
      const omega = firstMetadata.find(({ name }) => name === "omega");
      if (omega === undefined) throw new Error("omega fixture missing");

      provider.index = 1;
      await synchronization.sync(registration.sourceId);
      const secondMetadata = await catalog.listMetadata();
      const gamma = secondMetadata.find(({ name }) => name === "gamma");
      if (gamma === undefined) throw new Error("gamma fixture missing");
      expect(await catalog.advisoryStatus(omega.id, omega.revision)).toBe(
        "unavailable",
      );

      provider.index = 0;
      const restored = await synchronization.sync(registration.sourceId);
      expect(restored).toMatchObject({
        snapshotId: first.snapshotId,
        created: false,
      });
      const source = await isolated.pool.query<{
        current_published_snapshot_id: string | null;
      }>(
        "SELECT current_published_snapshot_id FROM github_sources WHERE id=$1",
        [registration.sourceId],
      );
      expect(source.rows[0]?.current_published_snapshot_id).toBe(
        first.snapshotId,
      );
      expect(await catalog.advisoryStatus(omega.id, omega.revision)).toBe(
        "available",
      );
      expect(await catalog.advisoryStatus(gamma.id, gamma.revision)).toBe(
        "unavailable",
      );
      expect((await catalog.listMetadata()).map(({ name }) => name)).toEqual([
        "alpha",
        "beta",
        "omega",
      ]);
      expect(
        (
          await isolated.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM external_source_snapshots",
          )
        ).rows[0]?.count,
      ).toBe("2");
    } finally {
      await isolated.close();
    }
  }, 120_000);

  it.each([
    { index: 5, expectedClassification: "quarantined" },
    { index: 6, expectedClassification: "verified" },
  ])(
    "marks revisions replaced by quarantined candidates unavailable (snapshot $index)",
    async ({ index, expectedClassification }) => {
      const isolated = await createTestDatabase();
      await isolated.migrate();
      try {
        const provider = new MutableNestedFixtureProvider(6100 + index);
        const store = new PostgresExternalCatalogStore(isolated.pool);
        const registration = await new SourceRegistrationService(
          provider,
          store,
        ).add(
          { owner: "fixture-org", repository: provider.repositoryName },
          "quarantine-reconciliation-admin",
        );
        const synchronization = new SourceSynchronizationService(
          provider,
          store,
        );
        const catalog = new PostgresImportedSkillCatalogProvider(isolated.pool);
        const first = await synchronization.sync(registration.sourceId);
        const alpha = (await catalog.listMetadata()).find(
          ({ name }) => name === "alpha",
        );
        if (alpha === undefined) throw new Error("alpha fixture missing");

        provider.index = index;
        const replacement = await synchronization.sync(registration.sourceId);

        expect(await catalog.advisoryStatus(alpha.id, alpha.revision)).toBe(
          "unavailable",
        );
        expect(
          (await catalog.listMetadata()).some(({ name }) => name === "alpha"),
        ).toBe(false);
        expect(
          (
            await isolated.pool.query<{
              current_published_snapshot_id: string | null;
              source_classification: string;
            }>(
              `SELECT current_published_snapshot_id,source_classification
               FROM github_sources WHERE id=$1`,
              [registration.sourceId],
            )
          ).rows[0],
        ).toEqual({
          current_published_snapshot_id: replacement.snapshotId,
          source_classification: expectedClassification,
        });
        expect(first.snapshotId).not.toBe(replacement.snapshotId);
      } finally {
        await isolated.close();
      }
    },
    120_000,
  );
  it("requires reverification before a shared quarantined revision can be curated", async () => {
    const isolated = await createTestDatabase();
    await isolated.migrate();
    try {
      const provider = new MutableNestedFixtureProvider(6012);
      const store = new PostgresExternalCatalogStore(isolated.pool);
      const registration = await new SourceRegistrationService(
        provider,
        store,
      ).add(
        { owner: "fixture-org", repository: provider.repositoryName },
        "shared-revision-admin",
      );
      const synchronization = new SourceSynchronizationService(provider, store);
      const catalog = new PostgresImportedSkillCatalogProvider(isolated.pool);

      const first = await synchronization.sync(registration.sourceId);
      const firstAlpha = first.candidateTraces.find(
        ({ skillName }) => skillName === "alpha",
      );
      const metadata = (await catalog.listMetadata()).find(
        ({ name }) => name === "alpha",
      );
      if (firstAlpha === undefined || metadata === undefined) {
        throw new Error("first alpha fixture missing");
      }

      provider.index = 1;
      const second = await synchronization.sync(registration.sourceId);
      const secondAlpha = second.candidateTraces.find(
        ({ skillName }) => skillName === "alpha",
      );
      if (secondAlpha === undefined) throw new Error("second alpha missing");
      expect(secondAlpha).toMatchObject({
        result: "reused",
        revision: firstAlpha.revision,
      });

      await store.transitionCandidate(
        firstAlpha.candidateId,
        "quarantined",
        "administrator",
        "shared-revision-admin",
        "ADMIN_QUARANTINE",
      );
      expect(
        await catalog.findRevision(metadata.id, metadata.revision),
      ).toBeUndefined();

      const reportSubjects = await isolated.pool.query<{
        candidate_id: string;
        id: string;
      }>(
        `SELECT candidate_id,id
         FROM external_verification_reports
         WHERE candidate_id=ANY($1::uuid[]) AND result='passed'
         ORDER BY candidate_id,created_at DESC`,
        [[firstAlpha.candidateId, secondAlpha.candidateId]],
      );
      const passedReportByCandidate = new Map(
        reportSubjects.rows.map(({ candidate_id, id }) => [candidate_id, id]),
      );
      const firstPassedReportId = passedReportByCandidate.get(
        firstAlpha.candidateId,
      );
      const secondPassedReportId = passedReportByCandidate.get(
        secondAlpha.candidateId,
      );
      if (
        firstPassedReportId === undefined ||
        secondPassedReportId === undefined
      ) {
        throw new Error("shared revision passed report missing");
      }
      const revisionSubject = await isolated.pool.query<{
        revision_id: string;
      }>(
        `SELECT revision_id
         FROM external_snapshot_skill_observations
         WHERE candidate_id=$1`,
        [secondAlpha.candidateId],
      );
      const sharedRevisionId = revisionSubject.rows[0]?.revision_id;
      if (sharedRevisionId === undefined) {
        throw new Error("shared revision subject missing");
      }
      const firstFailedReportId = randomUUID();
      const secondFailedReportId = randomUUID();
      await isolated.pool.query(
        `INSERT INTO external_verification_reports (
           id,candidate_id,policy_version,validator_version,input_sha256,
           report_sha256,result
         ) VALUES
           ($1,$3,'failed-report-policy','failed-report-validator',$5,$6,'failed'),
           ($2,$4,'failed-report-policy','failed-report-validator',$7,$8,'failed')`,
        [
          firstFailedReportId,
          secondFailedReportId,
          firstAlpha.candidateId,
          secondAlpha.candidateId,
          "a".repeat(64),
          "b".repeat(64),
          "c".repeat(64),
          "d".repeat(64),
        ],
      );
      const eligibilityAuditState = async () => {
        const result = await isolated.pool.query<{
          candidate_event_count: string;
          curation_decision_count: string;
          effective_classification: string;
          first_candidate_classification: string;
          revision_event_count: string;
          second_candidate_classification: string;
        }>(
          `SELECT
             (SELECT count(*)::text FROM external_classification_events
              WHERE candidate_id=ANY($1::uuid[])) AS candidate_event_count,
             (SELECT count(*)::text FROM external_revision_classification_events
              WHERE revision_id=$2) AS revision_event_count,
             (SELECT count(*)::text FROM external_curation_decisions)
               AS curation_decision_count,
             (SELECT classification FROM external_current_classifications
              WHERE candidate_id=$3) AS first_candidate_classification,
             (SELECT classification FROM external_current_classifications
              WHERE candidate_id=$4) AS second_candidate_classification,
             (SELECT classification FROM external_current_revision_classifications
              WHERE revision_id=$2) AS effective_classification`,
          [
            [firstAlpha.candidateId, secondAlpha.candidateId],
            sharedRevisionId,
            firstAlpha.candidateId,
            secondAlpha.candidateId,
          ],
        );
        return result.rows[0];
      };
      const beforeRejectedReports = await eligibilityAuditState();

      const expectCandidateVerificationReportRejected = async (
        reportId: string,
        error: RegExp,
      ) => {
        const client = await isolated.pool.connect();
        try {
          await client.query("BEGIN");
          await expect(
            client.query(
              `INSERT INTO external_classification_events (
                 id,candidate_id,previous_classification,next_classification,
                 actor_kind,actor_id,reason_code,report_id
               ) VALUES ($1,$2,'quarantined','verified','verifier',
                         'report-integrity-test','AUTOMATIC_VERIFICATION_PASSED',$3)`,
              [randomUUID(), firstAlpha.candidateId, reportId],
            ),
          ).rejects.toThrow(error);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      };
      const expectRevisionVerificationReportRejected = async (
        reportId: string,
        error: RegExp,
      ) => {
        const client = await isolated.pool.connect();
        try {
          await client.query("BEGIN");
          await expect(
            client.query(
              `INSERT INTO external_revision_classification_events (
                 id,revision_id,initiating_candidate_id,previous_classification,
                 next_classification,actor_kind,actor_id,reason_code,report_id
               ) VALUES ($1,$2,$3,'quarantined','verified','verifier',
                         'report-integrity-test','AUTOMATIC_VERIFICATION_PASSED',$4)`,
              [
                randomUUID(),
                sharedRevisionId,
                secondAlpha.candidateId,
                reportId,
              ],
            ),
          ).rejects.toThrow(error);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      };

      await expectCandidateVerificationReportRejected(
        firstFailedReportId,
        /passed verification report/i,
      );
      await expectCandidateVerificationReportRejected(
        secondPassedReportId,
        /report subject mismatch/i,
      );
      await expectCandidateVerificationReportRejected(
        randomUUID(),
        /report subject mismatch/i,
      );
      await expectRevisionVerificationReportRejected(
        secondFailedReportId,
        /passed verification report/i,
      );
      await expectRevisionVerificationReportRejected(
        firstPassedReportId,
        /report attribution mismatch/i,
      );
      await expectRevisionVerificationReportRejected(
        randomUUID(),
        /report attribution mismatch/i,
      );

      const passedCandidateControl = await isolated.pool.connect();
      try {
        await passedCandidateControl.query("BEGIN");
        const eventId = randomUUID();
        await passedCandidateControl.query(
          `INSERT INTO external_classification_events (
             id,candidate_id,previous_classification,next_classification,
             actor_kind,actor_id,reason_code,report_id
           ) VALUES ($1,$2,'quarantined','verified','verifier',
                     'report-integrity-test','AUTOMATIC_VERIFICATION_PASSED',$3)`,
          [eventId, firstAlpha.candidateId, firstPassedReportId],
        );
        await passedCandidateControl.query(
          `UPDATE external_current_classifications
           SET classification='verified',latest_event_id=$2
           WHERE candidate_id=$1`,
          [firstAlpha.candidateId, eventId],
        );
        await expect(
          passedCandidateControl.query<{ classification: string }>(
            `SELECT classification FROM external_current_classifications
             WHERE candidate_id=$1`,
            [firstAlpha.candidateId],
          ),
        ).resolves.toMatchObject({ rows: [{ classification: "verified" }] });
      } finally {
        await passedCandidateControl.query("ROLLBACK");
        passedCandidateControl.release();
      }
      const passedRevisionControl = await isolated.pool.connect();
      try {
        await passedRevisionControl.query("BEGIN");
        const eventId = randomUUID();
        await passedRevisionControl.query(
          `INSERT INTO external_revision_classification_events (
             id,revision_id,initiating_candidate_id,previous_classification,
             next_classification,actor_kind,actor_id,reason_code,report_id
           ) VALUES ($1,$2,$3,'quarantined','verified','verifier',
                     'report-integrity-test','AUTOMATIC_VERIFICATION_PASSED',$4)`,
          [
            eventId,
            sharedRevisionId,
            secondAlpha.candidateId,
            secondPassedReportId,
          ],
        );
        await passedRevisionControl.query(
          `UPDATE external_current_revision_classifications
           SET classification='verified',latest_event_id=$2
           WHERE revision_id=$1`,
          [sharedRevisionId, eventId],
        );
        await expect(
          passedRevisionControl.query<{ classification: string }>(
            `SELECT classification FROM external_current_revision_classifications
             WHERE revision_id=$1`,
            [sharedRevisionId],
          ),
        ).resolves.toMatchObject({ rows: [{ classification: "verified" }] });
      } finally {
        await passedRevisionControl.query("ROLLBACK");
        passedRevisionControl.release();
      }

      expect(await eligibilityAuditState()).toEqual(beforeRejectedReports);
      expect(
        await catalog.findRevision(metadata.id, metadata.revision),
      ).toBeUndefined();

      const candidateAuditState = async () => {
        const current = await isolated.pool.query<{
          candidate_id: string;
          classification: string;
          event_candidate_id: string;
          event_classification: string;
        }>(
          `SELECT current.candidate_id,current.classification,
                  event.candidate_id AS event_candidate_id,
                  event.next_classification AS event_classification
           FROM external_current_classifications current
           JOIN external_classification_events event
             ON event.id=current.latest_event_id
           WHERE current.candidate_id=ANY($1::uuid[])
           ORDER BY current.candidate_id`,
          [[firstAlpha.candidateId, secondAlpha.candidateId]],
        );
        const events = await isolated.pool.query<{
          candidate_id: string;
          previous_classification: string | null;
          next_classification: string;
        }>(
          `SELECT candidate_id,previous_classification,next_classification
           FROM external_classification_events
           WHERE candidate_id=ANY($1::uuid[])
           ORDER BY candidate_id,created_at,
                    (previous_classification IS NULL) DESC,id`,
          [[firstAlpha.candidateId, secondAlpha.candidateId]],
        );
        return { current: current.rows, events: events.rows };
      };
      const candidateEvents = (
        candidateId: string,
        audit: Awaited<ReturnType<typeof candidateAuditState>>,
      ) =>
        audit.events
          .filter((event) => event.candidate_id === candidateId)
          .map(({ previous_classification, next_classification }) => [
            previous_classification,
            next_classification,
          ]);

      const afterQuarantine = await candidateAuditState();
      expect(afterQuarantine.current).toEqual(
        [
          {
            candidate_id: firstAlpha.candidateId,
            classification: "quarantined",
            event_candidate_id: firstAlpha.candidateId,
            event_classification: "quarantined",
          },
          {
            candidate_id: secondAlpha.candidateId,
            classification: "verified",
            event_candidate_id: secondAlpha.candidateId,
            event_classification: "verified",
          },
        ].toSorted((left, right) =>
          left.candidate_id.localeCompare(right.candidate_id, "en-US"),
        ),
      );
      expect(candidateEvents(firstAlpha.candidateId, afterQuarantine)).toEqual([
        [null, "discovered"],
        ["discovered", "verified"],
        ["verified", "quarantined"],
      ]);
      expect(candidateEvents(secondAlpha.candidateId, afterQuarantine)).toEqual(
        [
          [null, "discovered"],
          ["discovered", "verified"],
        ],
      );

      await expect(
        store.transitionCandidate(
          secondAlpha.candidateId,
          "curated",
          "administrator",
          "shared-revision-admin",
          "ADMIN_CURATED",
        ),
      ).rejects.toThrow("CLASSIFICATION_TRANSITION_INVALID");

      const quarantined =
        await store.listAdministrativeCandidates("quarantined");
      const expectedAdministrativeClassifications = [
        firstAlpha.candidateId,
        secondAlpha.candidateId,
      ]
        .toSorted((left, right) => left.localeCompare(right, "en-US"))
        .map((candidateId) => ({
          candidateId,
          classification: "quarantined",
        }));
      expect(
        quarantined
          .filter(({ candidateId }) =>
            [firstAlpha.candidateId, secondAlpha.candidateId].includes(
              candidateId,
            ),
          )
          .map(({ candidateId, classification }) => ({
            candidateId,
            classification,
          }))
          .toSorted((left, right) =>
            left.candidateId.localeCompare(right.candidateId, "en-US"),
          ),
      ).toEqual(expectedAdministrativeClassifications);
      expect(
        (await store.listAdministrativeCandidates("verified")).some(
          ({ candidateId }) => candidateId === secondAlpha.candidateId,
        ),
      ).toBe(false);
      const quarantinedPage = await store.listAdministrativeCandidatesPage({
        classification: "quarantined",
        sourceId: registration.sourceId,
        limit: 100,
      });
      expect(
        quarantinedPage.items
          .filter(({ candidateId }) =>
            [firstAlpha.candidateId, secondAlpha.candidateId].includes(
              candidateId,
            ),
          )
          .map(({ candidateId, classification }) => ({
            candidateId,
            classification,
          }))
          .toSorted((left, right) =>
            left.candidateId.localeCompare(right.candidateId, "en-US"),
          ),
      ).toEqual(expectedAdministrativeClassifications);

      const leases = new PostgresSyncLeaseStore(isolated.pool);
      const lease = await leases.acquire(
        `sync/${registration.sourceId}`,
        randomUUID(),
        10_000,
      );
      if (lease === undefined) throw new Error("verification lease missing");
      try {
        await synchronization.syncScheduled(
          registration.sourceId,
          lease,
          {},
          "2".repeat(40),
          {
            repositoryId: provider.repositoryId,
            owner: "fixture-org",
            repository: provider.repositoryName,
          },
          secondAlpha.candidateId,
        );
      } finally {
        await leases.release(lease);
      }
      expect(
        (await catalog.listMetadata()).find(({ id }) => id === metadata.id),
      ).toMatchObject({ currentClassification: "verified" });

      const afterReverification = await candidateAuditState();
      expect(afterReverification.current).toEqual(afterQuarantine.current);
      expect(
        candidateEvents(secondAlpha.candidateId, afterReverification),
      ).toEqual([
        [null, "discovered"],
        ["discovered", "verified"],
      ]);

      await expect(
        store.transitionCandidate(
          secondAlpha.candidateId,
          "curated",
          "administrator",
          "shared-revision-admin",
          "ADMIN_CURATED",
        ),
      ).resolves.toMatchObject({ classification: "curated", changed: true });
      expect(
        (await catalog.listMetadata()).find(({ id }) => id === metadata.id),
      ).toMatchObject({ currentClassification: "curated" });

      const afterCuration = await candidateAuditState();
      expect(afterCuration.current).toEqual(
        [
          {
            candidate_id: firstAlpha.candidateId,
            classification: "quarantined",
            event_candidate_id: firstAlpha.candidateId,
            event_classification: "quarantined",
          },
          {
            candidate_id: secondAlpha.candidateId,
            classification: "curated",
            event_candidate_id: secondAlpha.candidateId,
            event_classification: "curated",
          },
        ].toSorted((left, right) =>
          left.candidate_id.localeCompare(right.candidate_id, "en-US"),
        ),
      );
      expect(candidateEvents(firstAlpha.candidateId, afterCuration)).toEqual([
        [null, "discovered"],
        ["discovered", "verified"],
        ["verified", "quarantined"],
      ]);
      expect(candidateEvents(secondAlpha.candidateId, afterCuration)).toEqual([
        [null, "discovered"],
        ["discovered", "verified"],
        ["verified", "curated"],
      ]);
      const revisionAudit = await isolated.pool.query<{
        previous_classification: string | null;
        next_classification: string;
      }>(
        `SELECT event.previous_classification,event.next_classification
         FROM external_revision_classification_events event
         JOIN external_current_revision_classifications current
           ON current.revision_id=event.revision_id
         JOIN external_snapshot_skill_observations observation
           ON observation.revision_id=current.revision_id
         WHERE observation.candidate_id=$1
         ORDER BY event.created_at,
                  (event.previous_classification IS NULL) DESC,event.id`,
        [secondAlpha.candidateId],
      );
      expect(
        revisionAudit.rows.map(
          ({ previous_classification, next_classification }) => [
            previous_classification,
            next_classification,
          ],
        ),
      ).toEqual([
        [null, "verified"],
        ["verified", "quarantined"],
        ["quarantined", "verified"],
        ["verified", "curated"],
      ]);
      const revisionCurrent = await isolated.pool.query<{
        revision_id: string;
        classification: string;
        event_revision_id: string;
        event_classification: string;
      }>(
        `SELECT current.revision_id,current.classification,
                event.revision_id AS event_revision_id,
                event.next_classification AS event_classification
         FROM external_current_revision_classifications current
         JOIN external_revision_classification_events event
           ON event.id=current.latest_event_id
         JOIN external_snapshot_skill_observations observation
           ON observation.revision_id=current.revision_id
         WHERE observation.candidate_id=$1`,
        [secondAlpha.candidateId],
      );
      expect(revisionCurrent.rows).toEqual([
        {
          revision_id: revisionCurrent.rows[0]?.revision_id,
          classification: "curated",
          event_revision_id: revisionCurrent.rows[0]?.revision_id,
          event_classification: "curated",
        },
      ]);
      const curationSubjects = await isolated.pool.query<{
        candidate_id: string | null;
        revision_id: string | null;
      }>(
        `SELECT candidate_event.candidate_id,revision_event.revision_id
         FROM external_curation_decisions decision
         LEFT JOIN external_classification_events candidate_event
           ON candidate_event.id=decision.classification_event_id
         LEFT JOIN external_revision_classification_events revision_event
           ON revision_event.id=decision.revision_classification_event_id
         WHERE decision.administrator_id='shared-revision-admin'
           AND decision.reason_code='ADMIN_CURATED'
         ORDER BY candidate_event.candidate_id NULLS LAST,
                  revision_event.revision_id NULLS LAST`,
      );
      expect(curationSubjects.rows).toEqual([
        {
          candidate_id: secondAlpha.candidateId,
          revision_id: null,
        },
        {
          candidate_id: null,
          revision_id: revisionCurrent.rows[0]?.revision_id,
        },
      ]);
    } finally {
      await isolated.close();
    }
  }, 120_000);

  it("serializes sibling transitions against the shared revision state", async () => {
    const isolated = await createTestDatabase();
    await isolated.migrate();
    const quarantinePool = new Pool({
      connectionString: isolated.connectionString,
      application_name: "shared-revision-quarantine",
    });
    const curatePool = new Pool({
      connectionString: isolated.connectionString,
      application_name: "shared-revision-curate",
    });
    const blocker = await isolated.pool.connect();
    let blocking = false;
    let quarantine:
      | ReturnType<PostgresExternalCatalogStore["transitionCandidate"]>
      | undefined;
    let curate:
      | ReturnType<PostgresExternalCatalogStore["transitionCandidate"]>
      | undefined;
    try {
      const provider = new MutableNestedFixtureProvider(6013);
      const registrationStore = new PostgresExternalCatalogStore(isolated.pool);
      const registration = await new SourceRegistrationService(
        provider,
        registrationStore,
      ).add(
        { owner: "fixture-org", repository: provider.repositoryName },
        "concurrent-shared-revision-admin",
      );
      const synchronization = new SourceSynchronizationService(
        provider,
        registrationStore,
      );
      const catalog = new PostgresImportedSkillCatalogProvider(isolated.pool);
      const first = await synchronization.sync(registration.sourceId);
      const firstAlpha = first.candidateTraces.find(
        ({ skillName }) => skillName === "alpha",
      );
      const metadata = (await catalog.listMetadata()).find(
        ({ name }) => name === "alpha",
      );
      provider.index = 1;
      const second = await synchronization.sync(registration.sourceId);
      const secondAlpha = second.candidateTraces.find(
        ({ skillName }) => skillName === "alpha",
      );
      if (
        firstAlpha === undefined ||
        secondAlpha === undefined ||
        metadata === undefined
      ) {
        throw new Error("shared alpha fixture missing");
      }

      await blocker.query("BEGIN");
      blocking = true;
      await blocker.query(
        `SELECT rc.revision_id
         FROM external_current_revision_classifications rc
         JOIN external_snapshot_skill_observations observation
           ON observation.revision_id=rc.revision_id
         WHERE observation.candidate_id=$1
         FOR UPDATE OF rc`,
        [secondAlpha.candidateId],
      );

      quarantine = new PostgresExternalCatalogStore(
        quarantinePool,
      ).transitionCandidate(
        firstAlpha.candidateId,
        "quarantined",
        "administrator",
        "concurrent-shared-revision-admin",
        "ADMIN_QUARANTINE",
      );
      await waitForDatabaseLock(isolated, "shared-revision-quarantine");
      curate = new PostgresExternalCatalogStore(curatePool).transitionCandidate(
        secondAlpha.candidateId,
        "curated",
        "administrator",
        "concurrent-shared-revision-admin",
        "ADMIN_CURATED",
      );
      await waitForDatabaseLock(isolated, "shared-revision-curate");

      await blocker.query("COMMIT");
      blocking = false;
      const [quarantineResult, curateResult] = await Promise.allSettled([
        quarantine,
        curate,
      ]);
      expect(quarantineResult.status).toBe("fulfilled");
      expect(curateResult.status).toBe("rejected");
      if (curateResult.status === "rejected") {
        expect(curateResult.reason).toMatchObject({
          message: "CLASSIFICATION_TRANSITION_INVALID",
        });
      }
      expect(
        await catalog.findRevision(metadata.id, metadata.revision),
      ).toBeUndefined();
    } finally {
      if (blocking) await blocker.query("ROLLBACK");
      await Promise.allSettled(
        [quarantine, curate].filter(
          (operation): operation is NonNullable<typeof operation> =>
            operation !== undefined,
        ),
      );
      blocker.release();
      await quarantinePool.end();
      await curatePool.end();
      await isolated.close();
    }
  }, 120_000);

  it("anchors snapshots to the final advisory head for zero, one, and multiple events with rollback", async () => {
    const isolated = await createTestDatabase();
    await isolated.migrate();
    try {
      const provider = new MutableNestedFixtureProvider(6010);
      const store = new PostgresExternalCatalogStore(isolated.pool);
      const registration = await new SourceRegistrationService(
        provider,
        store,
      ).add(
        { owner: "fixture-org", repository: provider.repositoryName },
        "advisory-anchor-admin",
      );
      const synchronization = new SourceSynchronizationService(provider, store);
      const chainState = async () => {
        const result = await isolated.pool.query<{
          last_sequence: string;
          last_event_sha256: string;
        }>(
          "SELECT last_sequence,last_event_sha256 FROM external_advisory_chain_head WHERE singleton",
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("advisory fixture head missing");
        return row;
      };
      const snapshotHead = async (snapshotId: string) =>
        (
          await isolated.pool.query<{ advisory_chain_head_sha256: string }>(
            "SELECT advisory_chain_head_sha256 FROM external_source_snapshots WHERE id=$1",
            [snapshotId],
          )
        ).rows[0]?.advisory_chain_head_sha256;
      const snapshotCount = async () =>
        Number(
          (
            await isolated.pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM external_source_snapshots",
            )
          ).rows[0]?.count,
        );
      const eventCount = async () =>
        Number(
          (
            await isolated.pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM external_revision_advisory_events",
            )
          ).rows[0]?.count,
        );

      const zero = await synchronization.sync(registration.sourceId);
      expect(await eventCount()).toBe(0);
      expect(await snapshotHead(zero.snapshotId)).toBe(
        (await chainState()).last_event_sha256,
      );

      provider.index = 1;
      const one = await synchronization.sync(registration.sourceId);
      expect(await eventCount()).toBe(1);
      expect(await snapshotHead(one.snapshotId)).toBe(
        (await chainState()).last_event_sha256,
      );

      const beforeFailure = {
        chain: await chainState(),
        events: await eventCount(),
        snapshots: await snapshotCount(),
      };
      const failAtSequence = BigInt(beforeFailure.chain.last_sequence) + 2n;
      await isolated.pool.query(`
        CREATE FUNCTION fail_second_sync_advisory() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.sequence = ${failAtSequence.toString()} THEN
            RAISE EXCEPTION 'injected second advisory failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER fail_second_sync_advisory
        BEFORE INSERT ON external_revision_advisory_events
        FOR EACH ROW EXECUTE FUNCTION fail_second_sync_advisory();
      `);
      provider.index = 4;
      await expect(synchronization.sync(registration.sourceId)).rejects.toThrow(
        "injected second advisory failure",
      );
      expect(await chainState()).toEqual(beforeFailure.chain);
      expect(await eventCount()).toBe(beforeFailure.events);
      expect(await snapshotCount()).toBe(beforeFailure.snapshots);
      await isolated.pool.query(`
        DROP TRIGGER fail_second_sync_advisory ON external_revision_advisory_events;
        DROP FUNCTION fail_second_sync_advisory();
      `);

      const multiple = await synchronization.sync(registration.sourceId);
      expect(await eventCount()).toBe(beforeFailure.events + 2);
      expect(await snapshotCount()).toBe(beforeFailure.snapshots + 1);
      expect(await snapshotHead(multiple.snapshotId)).toBe(
        (await chainState()).last_event_sha256,
      );
    } finally {
      await isolated.close();
    }
  }, 120_000);

  it("publishes changes, reuses equality, quarantines missing dependencies, and advises removals", async () => {
    const provider = new MutableNestedFixtureProvider();
    const store = new PostgresExternalCatalogStore(database.pool);
    const registration = await new SourceRegistrationService(
      provider,
      store,
    ).add({ owner: "fixture-org", repository: "nested-skills" }, "sync-admin");
    const synchronization = new SourceSynchronizationService(provider, store);
    const first = await synchronization.sync(registration.sourceId);
    expect(first.traces.map(({ result }) => result)).toEqual([
      "published",
      "published",
      "published",
    ]);

    provider.index = 1;
    provider.renamed = true;
    const second = await synchronization.sync(registration.sourceId);
    expect(
      second.traces.map(({ skillName, result }) => [skillName, result]),
    ).toEqual([
      ["alpha", "reused"],
      ["beta", "published"],
      ["gamma", "published"],
    ]);
    expect(
      second.candidateTraces.find(({ skillName }) => skillName === "broken"),
    ).toMatchObject({
      classification: "quarantined",
      reasonCodes: ["DEPENDENCY_MISSING"],
    });
    const initialTransitions = await database.pool.query<{
      previous_classification: string | null;
      next_classification: string;
    }>(
      `SELECT previous_classification,next_classification
       FROM external_classification_events e
       JOIN external_import_candidates c ON c.id=e.candidate_id
       WHERE c.id=$1 ORDER BY (previous_classification IS NULL) DESC`,
      [
        second.candidateTraces.find(({ skillName }) => skillName === "broken")
          ?.candidateId,
      ],
    );
    expect(
      initialTransitions.rows.map(
        ({ next_classification }) => next_classification,
      ),
    ).toEqual(["discovered", "quarantined"]);
    const finding = await database.pool.query<{
      reason_code: string;
      subject_locator_sha256: string;
      safe_context: Record<string, unknown>;
    }>(
      `SELECT f.reason_code,f.subject_locator_sha256,f.safe_context
       FROM external_validation_findings f
       JOIN external_verification_reports r ON r.id=f.report_id
       WHERE r.candidate_id=$1`,
      [
        second.candidateTraces.find(({ skillName }) => skillName === "broken")
          ?.candidateId,
      ],
    );
    expect(finding.rows).toEqual([
      {
        reason_code: "DEPENDENCY_MISSING",
        subject_locator_sha256: finding.rows[0]?.subject_locator_sha256,
        safe_context: {},
      },
    ]);
    expect(finding.rows[0]?.subject_locator_sha256).toMatch(/^[0-9a-f]{64}$/);
    const source = await database.pool.query<{ owner: string }>(
      "SELECT owner FROM github_sources WHERE id=$1",
      [registration.sourceId],
    );
    expect(source.rows[0]?.owner).toBe("fixture-renamed");
    expect(
      (
        await database.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM github_source_aliases WHERE source_id=$1",
          [registration.sourceId],
        )
      ).rows[0]?.count,
    ).toBe("2");

    const counts = await database.pool.query<{
      snapshots: string;
      revisions: string;
      missing: string;
      advisories: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM external_source_snapshots) AS snapshots,
        (SELECT count(*)::text FROM external_skill_revisions) AS revisions,
        (SELECT count(*)::text FROM external_snapshot_skill_observations WHERE result='missing') AS missing,
        (SELECT count(*)::text FROM external_revision_advisory_events WHERE advisory_status='unavailable') AS advisories
    `);
    expect(counts.rows[0]).toEqual({
      snapshots: "2",
      revisions: "5",
      missing: "1",
      advisories: "1",
    });
    const repeated = await synchronization.sync(registration.sourceId);
    expect(repeated.created).toBe(false);
    expect(provider.metadataConditionalCalls).toBe(3);
    expect(provider.metadataNotModified).toBe(1);
    const metadataCache = await database.pool.query<{
      metadata_etag: string;
      metadata_cache_sha256: string;
    }>(
      "SELECT metadata_etag,metadata_cache_sha256 FROM github_sources WHERE id=$1",
      [registration.sourceId],
    );
    expect(metadataCache.rows[0]).toMatchObject({
      metadata_etag: '"repository-v2"',
    });
    expect(metadataCache.rows[0]?.metadata_cache_sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    await database.pool.query(
      "UPDATE github_sources SET metadata_cache_sha256=$2 WHERE id=$1",
      [registration.sourceId, "0".repeat(64)],
    );
    await expect(synchronization.sync(registration.sourceId)).rejects.toThrow(
      "CACHE_MISS_ON_NOT_MODIFIED",
    );
    await database.pool.query(
      "UPDATE github_sources SET metadata_cache_sha256=$2 WHERE id=$1",
      [registration.sourceId, metadataCache.rows[0]?.metadata_cache_sha256],
    );
    const afterRepeat = await database.pool.query<{
      snapshots: string;
      revisions: string;
    }>(`
      SELECT (SELECT count(*)::text FROM external_source_snapshots) AS snapshots,
             (SELECT count(*)::text FROM external_skill_revisions) AS revisions
    `);
    expect(afterRepeat.rows[0]).toEqual({ snapshots: "2", revisions: "5" });

    const alpha = second.candidateTraces.find(
      ({ skillName }) => skillName === "alpha",
    );
    if (alpha === undefined) throw new Error("alpha candidate missing");
    await expect(
      store.transitionCandidate(
        alpha.candidateId,
        "curated",
        "administrator",
        "sync-admin",
        "ADMIN_CURATED",
      ),
    ).resolves.toMatchObject({ classification: "curated", changed: true });
    await expect(
      store.transitionCandidate(
        alpha.candidateId,
        "curated",
        "administrator",
        "sync-admin",
        "ADMIN_CURATED",
      ),
    ).resolves.toMatchObject({ changed: false });
    await expect(
      store.transitionCandidate(
        alpha.candidateId,
        "quarantined",
        "administrator",
        "sync-admin",
        "ADMIN_QUARANTINE",
      ),
    ).resolves.toMatchObject({ classification: "quarantined", changed: true });
    const trust = await database.pool.query<{ trust_at_publication: string }>(
      "SELECT DISTINCT trust_at_publication FROM external_skill_revisions",
    );
    expect(trust.rows).toEqual([
      { trust_at_publication: "structurally-verified" },
    ]);

    const leases = new PostgresSyncLeaseStore(database.pool);
    const stale = await leases.acquire(
      `sync/${registration.sourceId}`,
      randomUUID(),
      100,
    );
    if (stale === undefined) throw new Error("stale fixture lease missing");
    await new Promise((resolve) => setTimeout(resolve, 125));
    const active = await leases.acquire(
      `sync/${registration.sourceId}`,
      randomUUID(),
      5000,
    );
    if (active === undefined) throw new Error("active fixture lease missing");
    provider.index = 2;
    await expect(
      synchronization.syncScheduled(registration.sourceId, stale),
    ).rejects.toThrow("LEASE_LOST");
    expect(
      (
        await database.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM external_source_snapshots",
        )
      ).rows[0]?.count,
    ).toBe("2");
    await synchronization.syncScheduled(registration.sourceId, active);
    await leases.release(active);
    expect(
      (
        await database.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM external_source_snapshots",
        )
      ).rows[0]?.count,
    ).toBe("3");
    const retainedQuarantine = await database.pool.query<{
      classification: string;
    }>(`
      SELECT rc.classification
      FROM external_current_revision_classifications rc
      JOIN external_skill_revisions r ON r.id=rc.revision_id
      WHERE r.name='alpha'
    `);
    expect(retainedQuarantine.rows).toEqual([
      { classification: "quarantined" },
    ]);

    await expect(
      store.recordSourceUnavailable(registration.sourceId, {
        authenticated: true,
        uncached: true,
        repositoryId: provider.repositoryId,
      }),
    ).resolves.toBe(false);
    expect(
      (
        await database.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM external_revision_advisory_events",
        )
      ).rows[0]?.count,
    ).toBe("1");
    await database.pool.query(
      `UPDATE github_sources SET unavailable_confirmation_count=3,
         unavailable_first_observed_at=clock_timestamp()-interval '25 hours'
       WHERE id=$1`,
      [registration.sourceId],
    );
    await database.pool.query(
      `UPDATE github_source_aliases SET last_observed_at=clock_timestamp()-interval '26 hours'
       WHERE source_id=$1`,
      [registration.sourceId],
    );
    await expect(
      store.recordSourceUnavailable(registration.sourceId, {
        authenticated: true,
        uncached: true,
        repositoryId: provider.repositoryId,
      }),
    ).resolves.toBe(true);
    const retained = await database.pool.query<{
      revisions: string;
      unavailable: string;
    }>(`
      SELECT (SELECT count(*)::text FROM external_skill_revisions) AS revisions,
             (SELECT count(*)::text FROM external_revision_advisory_events
              WHERE advisory_status='unavailable') AS unavailable
    `);
    expect(retained.rows[0]).toEqual({ revisions: "6", unavailable: "4" });

    provider.index = 3;
    const cancellation = new AbortController();
    provider.abortOnNextBlob = cancellation;
    await expect(
      synchronization.sync(registration.sourceId, {
        signal: cancellation.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const afterCancellation = await database.pool.query<{
      snapshots: string;
      confirmations: number;
    }>(
      `
      SELECT (SELECT count(*)::text FROM external_source_snapshots) AS snapshots,
             unavailable_confirmation_count AS confirmations
      FROM github_sources WHERE id=$1
    `,
      [registration.sourceId],
    );
    expect(afterCancellation.rows[0]).toEqual({
      snapshots: "3",
      confirmations: 4,
    });
  }, 120_000);

  it.each([
    [3003, null, "LICENSE_MISSING"],
    [3004, "GNU General Public License, version 3", "LICENSE_UNSUPPORTED"],
  ] as const)(
    "quarantines nested repositories with invalid license evidence %#",
    async (repositoryId, licenseText, expectedReason) => {
      const provider = new MutableNestedFixtureProvider(
        repositoryId,
        licenseText,
      );
      const store = new PostgresExternalCatalogStore(database.pool);
      const registration = await new SourceRegistrationService(
        provider,
        store,
      ).add(
        { owner: "fixture-org", repository: provider.repositoryName },
        "sync-admin",
      );

      const result = await new SourceSynchronizationService(
        provider,
        store,
      ).sync(registration.sourceId);

      expect(result.traces).toEqual([]);
      expect(result.candidateTraces).toHaveLength(3);
      expect(result.candidateTraces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            classification: "quarantined",
            reasonCodes: [expectedReason],
          }),
        ]),
      );
    },
    120_000,
  );
});
