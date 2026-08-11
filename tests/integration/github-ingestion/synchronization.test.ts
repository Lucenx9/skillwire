import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
