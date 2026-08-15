import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SourceRegistrationService } from "../../../src/application/services/source-registration-service.js";
import { SourceSynchronizationService } from "../../../src/application/services/source-synchronization-service.js";
import { createExternalSkillRevision } from "../../../src/domain/external-catalog/canonical-revision-v2.js";
import { ExternalRevisionPublisher } from "../../../src/ingestion/external-revision-publisher.js";
import { runSourceAdmin } from "../../../src/ingestion/admin-cli.js";
import { GitHubCommitTreeBlobReader } from "../../../src/ingestion/github/commit-tree-blob-reader.js";
import { GitHubRestClient } from "../../../src/ingestion/github/rest-client.js";
import { PostgresExternalCatalogStore } from "../../../src/persistence/postgres/external-catalog-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";
import { createGitHubIngestionFixture } from "../../helpers/github-ingestion-fixture.js";

describe("registered mattpocock/skills ingestion", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
  }, 120_000);

  afterAll(async () => database.close());

  it("rolls back failure, then atomically publishes and reuses the exact 25-skill batch", async () => {
    const fixture = await createGitHubIngestionFixture();
    const provider = new GitHubCommitTreeBlobReader(
      new GitHubRestClient({ fetchImplementation: fixture.fetch }),
    );
    const store = new PostgresExternalCatalogStore(database.pool);
    const registration = new SourceRegistrationService(provider, store);
    const synchronization = new SourceSynchronizationService(provider, store);
    const registered = await registration.add(
      { owner: "mattpocock", repository: "skills" },
      "acceptance-admin",
    );
    expect(registered.created).toBe(true);
    expect(registered.repository).toMatchObject({
      repositoryId: fixture.inventory.repositoryId,
      owner: fixture.inventory.owner,
      repository: fixture.inventory.repository,
    });
    const duplicate = await registration.add(
      { owner: "mattpocock", repository: "skills" },
      "acceptance-admin",
    );
    expect(duplicate).toMatchObject({
      sourceId: registered.sourceId,
      created: false,
    });
    await expect(registration.list()).resolves.toHaveLength(1);

    await database.pool.query(`
      CREATE FUNCTION fail_tdd_publication() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'tdd' THEN RAISE EXCEPTION 'injected publication failure'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_tdd_publication
      BEFORE INSERT ON external_skill_revisions
      FOR EACH ROW EXECUTE FUNCTION fail_tdd_publication();
    `);
    await expect(synchronization.sync(registered.sourceId)).rejects.toThrow(
      /injected publication failure/i,
    );
    for (const table of [
      "external_source_snapshots",
      "external_content_objects",
      "external_skill_identities",
      "external_skill_revisions",
      "external_revision_resources",
      "external_revision_dependencies",
      "external_snapshot_skill_observations",
    ]) {
      const count = await database.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(count.rows[0]?.count, table).toBe("0");
    }
    await database.pool.query(`
      DROP TRIGGER fail_tdd_publication ON external_skill_revisions;
      DROP FUNCTION fail_tdd_publication();
    `);

    const published = await synchronization.sync(registered.sourceId);
    expect(published.created).toBe(true);
    expect(published.commitSha).toBe(fixture.inventory.commitSha);
    expect(published.traces).toHaveLength(25);
    expect(new Set(published.traces.map(({ skillPath }) => skillPath))).toEqual(
      new Set(fixture.inventory.skills.map(({ path }) => path)),
    );
    expect(published.traces.every(({ result }) => result === "published")).toBe(
      true,
    );
    expect(
      published.traces.every(({ revision }) =>
        /^gh-[0-9a-f]{64}$/.test(revision),
      ),
    ).toBe(true);

    const stored = await database.pool.query<{
      name: string;
      skill_path: string;
      commit_sha: string;
      source_owner: string;
      spdx_license_id: string;
      invocation_mode: string;
      trust_at_publication: string;
      bundle_sha256: string;
      canonical_bytes: string;
    }>(`
      SELECT name, skill_path, commit_sha, source_owner, spdx_license_id, invocation_mode,
             trust_at_publication,
             bundle_sha256, canonical_bytes
      FROM external_skill_revisions
      ORDER BY skill_path
    `);
    expect(stored.rows).toHaveLength(25);
    expect(
      stored.rows.every(
        (row) =>
          row.commit_sha === fixture.inventory.commitSha &&
          row.source_owner === fixture.inventory.sourceOwner &&
          row.spdx_license_id === "MIT" &&
          row.trust_at_publication === "structurally-verified" &&
          createHash("sha256").update(row.canonical_bytes).digest("hex") ===
            row.bundle_sha256,
      ),
    ).toBe(true);
    const byteTotals = await database.pool.query<{
      decoded_bytes: string;
      reconciled_decoded_bytes: string | null;
    }>(
      `
      SELECT snapshot.decoded_bytes::text,
             reconciliation.reconciled_decoded_bytes::text
      FROM external_source_snapshots snapshot
      LEFT JOIN external_snapshot_byte_total_reconciliations reconciliation
        ON reconciliation.snapshot_id=snapshot.id
      WHERE snapshot.id=$1
    `,
      [published.snapshotId],
    );
    const canonicalByteTotal = stored.rows.reduce(
      (total, { canonical_bytes }) =>
        total + Buffer.byteLength(canonical_bytes, "utf8"),
      0,
    );
    expect(byteTotals.rows).toEqual([
      {
        decoded_bytes: String(canonicalByteTotal),
        reconciled_decoded_bytes: String(canonicalByteTotal),
      },
    ]);
    const expectedInvocationModes = new Map(
      fixture.inventory.skills.map(({ name, userOnly }) => [
        name,
        userOnly ? "user-only" : "automatic",
      ]),
    );
    expect(
      stored.rows.every(
        ({ name, invocation_mode }) =>
          expectedInvocationModes.get(name) === invocation_mode,
      ),
    ).toBe(true);

    const grillDependencies = await database.pool.query<{
      target_skill_name: string;
      target_skill_identity_id: string;
      target_revision_id: string;
      evidence_source_sha256: string;
      evidence_kind: string;
      evidence_locator: string;
    }>(`
      SELECT d.target_skill_name, d.target_skill_identity_id, d.target_revision_id,
             d.evidence_source_sha256, d.evidence_kind, d.evidence_locator
      FROM external_revision_dependencies d
      JOIN external_skill_revisions r ON r.id = d.revision_id
      WHERE r.name = 'grill-with-docs'
      ORDER BY d.target_skill_name
    `);
    expect(grillDependencies.rows).toEqual([
      {
        target_skill_name: "domain-modeling",
        target_skill_identity_id:
          grillDependencies.rows[0]?.target_skill_identity_id,
        target_revision_id: grillDependencies.rows[0]?.target_revision_id,
        evidence_source_sha256:
          grillDependencies.rows[0]?.evidence_source_sha256,
        evidence_kind: "explicit-invocation",
        evidence_locator: grillDependencies.rows[0]?.evidence_locator,
      },
      {
        target_skill_name: "grilling",
        target_skill_identity_id:
          grillDependencies.rows[1]?.target_skill_identity_id,
        target_revision_id: grillDependencies.rows[1]?.target_revision_id,
        evidence_source_sha256:
          grillDependencies.rows[1]?.evidence_source_sha256,
        evidence_kind: "explicit-invocation",
        evidence_locator: grillDependencies.rows[1]?.evidence_locator,
      },
    ]);
    expect(
      grillDependencies.rows.every(({ evidence_locator }) =>
        /^instructions:\d+$/.test(evidence_locator),
      ),
    ).toBe(true);
    expect(
      grillDependencies.rows.every(
        ({
          target_skill_identity_id,
          target_revision_id,
          evidence_source_sha256,
        }) =>
          /^[0-9a-f-]{36}$/.test(target_skill_identity_id) &&
          /^[0-9a-f-]{36}$/.test(target_revision_id) &&
          /^[0-9a-f]{64}$/.test(evidence_source_sha256),
      ),
    ).toBe(true);
    const resources = await database.pool.query<{ resource_path: string }>(
      "SELECT resource_path FROM external_revision_resources ORDER BY resource_path",
    );
    expect(resources.rows.map(({ resource_path }) => resource_path)).toEqual(
      fixture.inventory.skills
        .flatMap(({ resources: expected }) => expected)
        .toSorted(),
    );
    const firstPage = await store.listAdministrativeCandidatesPage({
      limit: 10,
    });
    expect(firstPage.items).toHaveLength(10);
    expect(firstPage.nextCursor).toMatch(/^[0-9a-f-]{36}$/);
    const secondPage = await store.listAdministrativeCandidatesPage({
      limit: 10,
      cursor: firstPage.nextCursor ?? undefined,
      sourceId: registered.sourceId,
      classification: "verified",
    });
    expect(secondPage.items).toHaveLength(10);
    expect(
      new Set(
        [...firstPage.items, ...secondPage.items].map(
          ({ candidateId }) => candidateId,
        ),
      ).size,
    ).toBe(20);
    expect(
      [...firstPage.items, ...secondPage.items].every(
        ({ sourceId, classification }) =>
          sourceId === registered.sourceId && classification === "verified",
      ),
    ).toBe(true);

    const overwrite = createExternalSkillRevision({
      skillId: `gh-${String(fixture.inventory.repositoryId)}-overwrite-deadbeef`,
      provenance: {
        provider: "github",
        repositoryId: fixture.inventory.repositoryId,
        owner: fixture.inventory.owner,
        repository: fixture.inventory.repository,
        commitSha: fixture.inventory.commitSha,
        skillPath: "skills/overwrite/SKILL.md",
        sourceOwner: fixture.inventory.sourceOwner,
        spdxLicenseId: "MIT",
        licenseText: "MIT License\n",
      },
      skill: {
        name: "overwrite",
        description: "Conflicting replacement attempt.",
        skillPath: "skills/overwrite/SKILL.md",
        instructions: "Do not publish.\n",
        invocationMode: "automatic",
        resources: [],
        dependencies: [],
      },
    });
    await expect(
      new ExternalRevisionPublisher(store).publish({
        sourceId: registered.sourceId,
        commitSha: fixture.inventory.commitSha,
        treeSha: fixture.treeSha,
        manifestVersion: "9.9.9",
        revisions: [overwrite],
      }),
    ).rejects.toThrow("PUBLICATION_CONFLICT");

    const second = await synchronization.sync(registered.sourceId);
    expect(second).toMatchObject({
      snapshotId: published.snapshotId,
      commitSha: fixture.inventory.commitSha,
      created: false,
    });
    expect(second.traces).toEqual(published.traces);
    const counts = await database.pool.query<{
      snapshots: string;
      revisions: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM external_source_snapshots) AS snapshots,
        (SELECT count(*)::text FROM external_skill_revisions) AS revisions
    `);
    expect(counts.rows[0]).toEqual({ snapshots: "1", revisions: "25" });

    const environment = {
      DATABASE_URL: database.connectionString,
      SKILLWIRE_ADMIN_ACTOR_ID: "acceptance-admin",
      SKILLWIRE_ADMIN_AUTHORITY: "active",
    };
    await expect(
      runSourceAdmin(["source:list"], environment, {
        fetchImplementation: fixture.fetch,
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: "source:list",
      sources: [{ sourceId: registered.sourceId }],
    });
    const cliSync = await runSourceAdmin(
      ["source:sync", "--source-id", registered.sourceId],
      environment,
      { fetchImplementation: fixture.fetch },
    );
    expect(cliSync).toMatchObject({
      ok: true,
      command: "source:sync",
      sourceId: registered.sourceId,
      state: "queued",
      created: true,
    });
    const cliAdd = await runSourceAdmin(
      [
        "source:add",
        "--owner",
        fixture.inventory.owner,
        "--repository",
        fixture.inventory.repository,
      ],
      environment,
      { fetchImplementation: fixture.fetch },
    );
    expect(cliAdd).toMatchObject({
      ok: true,
      command: "source:add",
      sourceId: registered.sourceId,
      created: false,
      state: "queued",
    });
  }, 120_000);
});
