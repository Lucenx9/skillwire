import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SourceRegistrationService } from "../../../src/application/services/source-registration-service.js";
import { SourceSynchronizationService } from "../../../src/application/services/source-synchronization-service.js";
import { createSearchSkills } from "../../../src/application/use-cases/search-skills.js";
import { createLoadSkill } from "../../../src/application/use-cases/load-skill.js";
import { createReadSkillResource } from "../../../src/application/use-cases/read-skill-resource.js";
import { GitHubCommitTreeBlobReader } from "../../../src/ingestion/github/commit-tree-blob-reader.js";
import { GitHubRestClient } from "../../../src/ingestion/github/rest-client.js";
import { PostgresExternalCatalogStore } from "../../../src/persistence/postgres/external-catalog-store.js";
import { PostgresImportedSkillCatalogProvider } from "../../../src/persistence/postgres/imported-skill-catalog-provider.js";
import { UnifiedCatalogProvider } from "../../../src/catalog/unified-catalog-provider.js";
import { adaptStaticCatalogProvider } from "../../../src/catalog/static-catalog-adapter.js";
import { loadVerifiedCatalogProvider } from "../../../src/catalog/version-controlled-provider.js";
import { FakeRepositoryMemoryStore } from "../../helpers/memory-store.js";
import type { RequestPrincipal } from "../../../src/domain/repository-memory/types.js";
import { hashExternalAdvisoryEvent } from "../../../src/domain/external-catalog/external-advisory-chain.js";
import { rankSkills } from "../../../src/domain/catalog/ranking.js";
import { repositoryMemoryScope } from "../../../src/domain/repository-memory/types.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";
import { createGitHubIngestionFixture } from "../../helpers/github-ingestion-fixture.js";

const principal: RequestPrincipal = {
  accountId: "00000000-0000-4000-8000-000000000901",
  apiKeyId: "00000000-0000-4000-8000-000000000902",
  requestId: "imported-provider-test",
};

describe("PostgreSQL imported catalog provider", () => {
  let database: TestDatabase;
  let imported: PostgresImportedSkillCatalogProvider;
  let sourceId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    const fixture = await createGitHubIngestionFixture();
    const github = new GitHubCommitTreeBlobReader(
      new GitHubRestClient({ fetchImplementation: fixture.fetch }),
    );
    const store = new PostgresExternalCatalogStore(database.pool);
    const registration = await new SourceRegistrationService(github, store).add(
      { owner: "mattpocock", repository: "skills" },
      "provider-test",
    );
    sourceId = registration.sourceId;
    await new SourceSynchronizationService(github, store).sync(sourceId);
    imported = new PostgresImportedSkillCatalogProvider(database.pool);
  }, 120_000);

  afterAll(async () => database.close());

  it("reads all eligible metadata directly from PostgreSQL and survives provider restart", async () => {
    const metadata = await imported.listMetadata(principal);
    expect(metadata).toHaveLength(25);
    expect(
      metadata.filter(({ invocationMode }) => invocationMode === "user-only"),
    ).toHaveLength(14);
    expect(
      metadata.every(
        ({ currentClassification }) => currentClassification === "verified",
      ),
    ).toBe(true);

    const restarted = new PostgresImportedSkillCatalogProvider(database.pool);
    expect(await restarted.listMetadata(principal)).toEqual(metadata);
  });

  it("re-verifies exact bundles and progressively reads every declared resource", async () => {
    const metadata = await imported.listMetadata(principal);
    let resourceCount = 0;
    for (const entry of metadata) {
      const revision = await imported.findRevision(
        entry.id,
        entry.revision,
        principal,
      );
      expect(revision?.catalogOrigin).toMatchObject({
        owner: "mattpocock",
        repository: "skills",
        commitSha: "84fdeffd12f2ee307994d1eb6feb48173b6e0502",
        license: { spdxId: "MIT", attribution: "Matt Pocock" },
      });
      const reader = createReadSkillResource(imported);
      for (const resource of revision?.resourceManifest ?? []) {
        const loaded = await reader.execute(
          {
            skillId: entry.id,
            revision: entry.revision,
            path: resource.path,
          },
          principal,
        );
        expect(loaded.sha256).toBe(resource.sha256);
        resourceCount += 1;
      }
    }
    expect(resourceCount).toBe(21);
  });

  it("merges deterministically, filters invocation mode, and applies memory only after relevance", async () => {
    const unified = new UnifiedCatalogProvider([
      adaptStaticCatalogProvider(
        loadVerifiedCatalogProvider(process.cwd(), "launch-catalog-v1"),
      ),
      imported,
    ]);
    const memory = new FakeRepositoryMemoryStore();
    const search = createSearchSkills(unified, memory);
    const load = createLoadSkill(unified, memory);
    const userOnly = (await imported.listMetadata(principal)).find(
      ({ name }) => name === "ask-matt",
    );
    if (userOnly === undefined) throw new Error("fixture missing ask-matt");
    await load.execute(
      {
        skillId: userOnly.id,
        revision: userOnly.revision,
        repositoryHash: "a".repeat(64),
      },
      principal,
    );
    const automatic = await search.execute(
      { task: "ask matt", repositoryHash: "a".repeat(64), limit: 10 },
      principal,
    );
    expect(
      automatic.skills.some(({ skillId }) => skillId === userOnly.id),
    ).toBe(false);
    const requested = await search.execute(
      {
        task: "ask matt",
        invocationContext: "user-requested",
        repositoryHash: "a".repeat(64),
        limit: 10,
      },
      principal,
    );
    expect(requested.skills[0]?.skillId).toBe(userOnly.id);
    expect(
      await search.execute(
        {
          task: "quasar xylophone zephyr",
          invocationContext: "user-requested",
          repositoryHash: "a".repeat(64),
          limit: 10,
        },
        principal,
      ),
    ).toMatchObject({ skills: [] });

    const rankingCatalog = await unified.listMetadata(principal);
    let task = "";
    let baseline = rankSkills(rankingCatalog, "code", 35);
    let tie = baseline.find(
      (entry, index) => baseline[index + 1]?.score === entry.score,
    );
    for (const candidateTask of [
      "skill",
      "user",
      "work",
      "repository",
      "test",
      "design",
    ]) {
      if (tie !== undefined) break;
      const candidateRanking = rankSkills(rankingCatalog, candidateTask, 35);
      const candidateTie = candidateRanking.find(
        (entry, index) => candidateRanking[index + 1]?.score === entry.score,
      );
      if (candidateTie !== undefined) {
        task = candidateTask;
        baseline = candidateRanking;
        tie = candidateTie;
      }
    }
    if (tie === undefined) throw new Error("fixture missing ranking tie");
    if (task.length === 0) task = "code";
    const peer = baseline[baseline.indexOf(tie) + 1];
    if (peer === undefined) throw new Error("fixture missing ranking peer");
    const rankingRepository = "d".repeat(64);
    await load.execute(
      {
        skillId: peer.skill.id,
        revision: peer.skill.revision,
        repositoryHash: rankingRepository,
      },
      principal,
    );
    await memory.replaceOutcome(
      repositoryMemoryScope(principal.accountId, rankingRepository),
      peer.skill.id,
      peer.skill.revision,
      "useful",
    );
    const boosted = await search.execute(
      {
        task,
        invocationContext: "user-requested",
        repositoryHash: rankingRepository,
        limit: 35,
      },
      principal,
    );
    expect(
      boosted.skills.findIndex(({ skillId }) => skillId === peer.skill.id),
    ).toBeLessThan(
      boosted.skills.findIndex(({ skillId }) => skillId === tie.skill.id),
    );
  });

  it("excludes quarantined candidates while preserving curated ones", async () => {
    const store = new PostgresExternalCatalogStore(database.pool);
    const candidates = await store.listAdministrativeCandidates();
    const ask = candidates.find(({ revision }) => revision !== undefined);
    if (ask === undefined) throw new Error("fixture missing candidate");
    await store.transitionCandidate(
      ask.candidateId,
      "curated",
      "administrator",
      "provider-test",
      "ADMIN_CURATED",
    );
    expect(
      (await imported.listMetadata(principal)).some(
        ({ revision, currentClassification }) =>
          revision === ask.revision && currentClassification === "curated",
      ),
    ).toBe(true);

    const verified = (await store.listAdministrativeCandidates("verified"))[0];
    if (verified === undefined) throw new Error("fixture missing candidate");
    await store.transitionCandidate(
      verified.candidateId,
      "quarantined",
      "administrator",
      "provider-test",
      "ADMIN_QUARANTINE",
    );
    expect(
      (await imported.listMetadata(principal)).some(
        ({ revision }) => revision === verified.revision,
      ),
    ).toBe(false);
    expect(
      await imported.findRevision(
        (
          await database.pool.query<{ catalog_skill_id: string }>(
            `SELECT i.catalog_skill_id FROM external_import_candidates c
           JOIN external_skill_identities i ON i.id=c.skill_identity_id
           WHERE c.id=$1`,
            [verified.candidateId],
          )
        ).rows[0]?.catalog_skill_id ?? "missing",
        verified.revision ?? "missing",
        principal,
      ),
    ).toBeUndefined();
  });

  it("omits unavailable revisions from discovery, serves their verified cache, and denies revoked loads", async () => {
    const store = new PostgresExternalCatalogStore(database.pool);
    const selected = (await imported.listMetadata(principal))[0];
    if (selected === undefined) throw new Error("fixture missing skill");
    await database.pool.query(
      `UPDATE github_sources SET unavailable_confirmation_count=3,
         unavailable_first_observed_at=clock_timestamp() - interval '2 days'
       WHERE id=$1`,
      [sourceId],
    );
    await expect(store.recordSourceUnavailable(sourceId)).resolves.toBe(true);
    expect(await imported.listMetadata(principal)).toEqual([]);
    expect(
      await imported.advisoryStatus(selected.id, selected.revision, principal),
    ).toBe("unavailable");
    expect(
      await imported.findRevision(selected.id, selected.revision, principal),
    ).toBeDefined();

    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const head = await client.query<{
        last_sequence: string;
        last_event_sha256: string;
      }>(
        "SELECT last_sequence,last_event_sha256 FROM external_advisory_chain_head WHERE singleton FOR UPDATE",
      );
      const revision = await client.query<{ id: string }>(
        `SELECT r.id FROM external_skill_revisions r
         JOIN external_skill_identities i ON i.id=r.skill_identity_id
         WHERE i.catalog_skill_id=$1 AND r.revision=$2`,
        [selected.id, selected.revision],
      );
      const previous = head.rows[0];
      const revisionId = revision.rows[0]?.id;
      if (previous === undefined || revisionId === undefined) {
        throw new Error("fixture advisory input missing");
      }
      const sequence = (BigInt(previous.last_sequence) + 1n).toString();
      const effectiveAt = new Date().toISOString();
      const eventSha256 = hashExternalAdvisoryEvent({
        sequence,
        previousEventSha256: previous.last_event_sha256,
        revisionId,
        kind: "security",
        status: "revoked",
        reasonCode: "SECURITY_REVOCATION",
        effectiveAt,
      });
      await client.query(
        `INSERT INTO external_revision_advisory_events (
           id,sequence,previous_event_sha256,event_sha256,revision_id,
           advisory_kind,advisory_status,reason_code,effective_at
         ) VALUES ($1,$2,$3,$4,$5,'security','revoked',$6,$7)`,
        [
          randomUUID(),
          sequence,
          previous.last_event_sha256,
          eventSha256,
          revisionId,
          "SECURITY_REVOCATION",
          effectiveAt,
        ],
      );
      await client.query(
        "UPDATE external_advisory_chain_head SET last_sequence=$1,last_event_sha256=$2 WHERE singleton",
        [sequence, eventSha256],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect(
      await imported.advisoryStatus(selected.id, selected.revision, principal),
    ).toBe("revoked");
    expect(
      await imported.findRevision(selected.id, selected.revision, principal),
    ).toBeUndefined();
  });
});
