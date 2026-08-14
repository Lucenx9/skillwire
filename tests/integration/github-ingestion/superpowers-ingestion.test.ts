import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SourceRegistrationService } from "../../../src/application/services/source-registration-service.js";
import { SourceSynchronizationService } from "../../../src/application/services/source-synchronization-service.js";
import { GitHubCommitTreeBlobReader } from "../../../src/ingestion/github/commit-tree-blob-reader.js";
import { GitHubRestClient } from "../../../src/ingestion/github/rest-client.js";
import { ExternalRevisionPublisher } from "../../../src/ingestion/external-revision-publisher.js";
import { PostgresExternalCatalogStore } from "../../../src/persistence/postgres/external-catalog-store.js";
import { createTestDatabase } from "../../helpers/database.js";
import { snapshotTree } from "../../helpers/filesystem-snapshot.js";
import { createSuperpowersIngestionFixture } from "../../helpers/github-ingestion-fixture.js";

const COMMIT_SHA = "b36e0829c6d0140e93cfef2ca599b1b07d4a7797";
const TREE_SHA = "21219529a4e224bcb27baf8816b039c8bf7c6673";
const LICENSE_SHA256 =
  "a37e0e9697144819e1d965176ac4ae5bc3fa02d11e7812036bbcadf6dafe2400";
const LICENSE_BLOB_SHA = "abf0390320aa14406af7a520b9b0739fdda9bf08";
const clientTree = fileURLToPath(
  new URL("../../fixtures/client-tree/", import.meta.url),
);

describe("registered obra/superpowers nested fallback", () => {
  it("considers all 14 nested skills independently and publishes only valid directory-scoped bundles", async () => {
    const beforeClientTree = await snapshotTree(clientTree);
    const fixture = await createSuperpowersIngestionFixture();
    const database = await createTestDatabase();
    try {
      await database.migrate();
      const provider = new GitHubCommitTreeBlobReader(
        new GitHubRestClient({ fetchImplementation: fixture.fetch }),
      );
      const store = new PostgresExternalCatalogStore(database.pool);
      const registration = await new SourceRegistrationService(
        provider,
        store,
      ).add({ owner: "obra", repository: "superpowers" }, "fixture-admin");
      const publisher = new ExternalRevisionPublisher(store);
      const priorQuarantine = await publisher.publish({
        sourceId: registration.sourceId,
        commitSha: COMMIT_SHA,
        treeSha: TREE_SHA,
        manifestVersion: "invalid-v1",
        adapterKind: "claude-plugin",
        revisions: [],
        candidates: [
          {
            skillPath: "_invalid/0cb7c64587519273/SKILL.md",
            name: "invalid-0cb7c64587519273",
            description: "Repository manifest failed deterministic validation.",
            adapterKind: "claude-plugin",
            classification: "quarantined",
            findings: [
              {
                code: "MANIFEST_INVALID",
                severity: "error",
                subjectKind: "snapshot",
                subjectId: "manifest",
              },
            ],
          },
        ],
        observedRepository: registration.repository,
      });
      await expect(
        publisher.publish({
          sourceId: registration.sourceId,
          commitSha: COMMIT_SHA,
          treeSha: "0".repeat(40),
          manifestVersion: "invalid-v2",
          adapterKind: "claude-plugin",
          revisions: [],
          candidates: [
            {
              skillPath: "_invalid/tree-mismatch/SKILL.md",
              name: "invalid-tree-mismatch",
              description: "A commit cannot resolve to a different tree.",
              adapterKind: "claude-plugin",
              classification: "quarantined",
              findings: [
                {
                  code: "MANIFEST_INVALID",
                  severity: "error",
                  subjectKind: "snapshot",
                  subjectId: "manifest",
                },
              ],
            },
          ],
          observedRepository: registration.repository,
        }),
      ).rejects.toThrow("PUBLICATION_CONFLICT");
      const synchronization = new SourceSynchronizationService(provider, store);
      const published = await synchronization.sync(registration.sourceId);

      expect(published).toMatchObject({
        created: true,
        commitSha: COMMIT_SHA,
        treeSha: TREE_SHA,
        resourceCount: 2,
      });
      expect(published.snapshotId).not.toBe(priorQuarantine.snapshotId);
      expect(published.candidateTraces).toHaveLength(14);
      expect(
        published.candidateTraces.map(({ skillName }) => skillName),
      ).toEqual(fixture.inventory.skills.map(({ name }) => name));
      expect(
        published.candidateTraces
          .filter(({ classification }) => classification === "quarantined")
          .map(({ skillName, reasonCodes }) => ({ skillName, reasonCodes })),
      ).toEqual([
        {
          skillName: "subagent-driven-development",
          reasonCodes: ["PATH_UNSAFE"],
        },
        { skillName: "writing-skills", reasonCodes: ["PATH_UNSAFE"] },
      ]);
      const expectedPublished = fixture.inventory.skills
        .map(({ name }) => name)
        .filter(
          (name) =>
            !["subagent-driven-development", "writing-skills"].includes(name),
        );
      expect(published.traces.map(({ skillName }) => skillName)).toEqual(
        expectedPublished,
      );

      const revisions = await database.pool.query<{
        name: string;
        commit_sha: string;
        source_owner: string;
        spdx_license_id: string;
        license_sha256: string;
        license_evidence_path: string;
        license_blob_sha: string;
        canonical_bytes: string;
        bundle_sha256: string;
      }>(
        `SELECT r.name,r.commit_sha,r.source_owner,r.spdx_license_id,
                r.license_sha256,r.license_evidence_path,r.license_blob_sha,
                r.canonical_bytes,r.bundle_sha256
         FROM external_skill_revisions r
         JOIN external_skill_identities i ON i.id=r.skill_identity_id
         WHERE i.source_id=$1
         ORDER BY r.skill_path`,
        [registration.sourceId],
      );
      expect(revisions.rows).toHaveLength(12);
      expect(
        revisions.rows.every(
          (row) =>
            row.commit_sha === COMMIT_SHA &&
            row.source_owner === "Jesse Vincent" &&
            row.spdx_license_id === "MIT" &&
            row.license_sha256 === LICENSE_SHA256 &&
            row.license_evidence_path === "LICENSE" &&
            row.license_blob_sha === LICENSE_BLOB_SHA &&
            createHash("sha256").update(row.canonical_bytes).digest("hex") ===
              row.bundle_sha256,
        ),
      ).toBe(true);

      const resources = await database.pool.query<{
        name: string;
        resource_path: string;
      }>(
        `SELECT r.name,rr.resource_path
         FROM external_revision_resources rr
         JOIN external_skill_revisions r ON r.id=rr.revision_id
         JOIN external_skill_identities i ON i.id=r.skill_identity_id
         WHERE i.source_id=$1
         ORDER BY r.name,rr.resource_path`,
        [registration.sourceId],
      );
      expect(resources.rows).toEqual([
        {
          name: "requesting-code-review",
          resource_path: "code-reviewer.md",
        },
        {
          name: "test-driven-development",
          resource_path: "writing-good-tests.md",
        },
      ]);
      expect(
        resources.rows.some(({ resource_path }) =>
          /(?:plugin|hook|agent|command|install)/iu.test(resource_path),
        ),
      ).toBe(false);

      await expect(
        database.pool.query<{
          adapter_kind: string;
          classification: string;
          candidates: string;
        }>(
          `SELECT s.adapter_kind,c.classification,count(*)::text AS candidates
           FROM external_source_snapshots s
           JOIN external_import_candidates i ON i.snapshot_id=s.id
           JOIN external_current_classifications c ON c.candidate_id=i.id
           WHERE s.source_id=$1
           GROUP BY s.id,s.adapter_kind,c.classification
           ORDER BY s.adapter_kind,c.classification`,
          [registration.sourceId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            adapter_kind: "claude-plugin",
            classification: "quarantined",
            candidates: "1",
          },
          {
            adapter_kind: "nested-skill",
            classification: "quarantined",
            candidates: "2",
          },
          {
            adapter_kind: "nested-skill",
            classification: "verified",
            candidates: "12",
          },
        ],
      });

      await expect(
        synchronization.sync(registration.sourceId),
      ).resolves.toMatchObject({
        created: false,
        snapshotId: published.snapshotId,
        commitSha: COMMIT_SHA,
        treeSha: TREE_SHA,
        candidateTraces: published.candidateTraces,
      });
      await database.pool.query(
        "ALTER TABLE external_source_snapshots DISABLE TRIGGER external_snapshots_immutable",
      );
      await database.pool.query(
        "UPDATE external_source_snapshots SET validation_input_sha256=NULL WHERE id=$1",
        [published.snapshotId],
      );
      await database.pool.query(
        "ALTER TABLE external_source_snapshots ENABLE TRIGGER external_snapshots_immutable",
      );
      await expect(
        synchronization.sync(registration.sourceId),
      ).resolves.toMatchObject({
        created: false,
        snapshotId: published.snapshotId,
        commitSha: COMMIT_SHA,
        treeSha: TREE_SHA,
        candidateTraces: published.candidateTraces,
      });
      await database.pool.query(
        "ALTER TABLE external_verification_reports DISABLE TRIGGER external_reports_immutable",
      );
      await database.pool.query(
        `UPDATE external_verification_reports
         SET input_sha256=$2
         WHERE candidate_id=(
           SELECT id FROM external_import_candidates
           WHERE snapshot_id=$1
           ORDER BY skill_document_path
           LIMIT 1
         )`,
        [published.snapshotId, "0".repeat(64)],
      );
      await database.pool.query(
        "ALTER TABLE external_verification_reports ENABLE TRIGGER external_reports_immutable",
      );
      const revalidated = await synchronization.sync(registration.sourceId);
      expect(revalidated).toMatchObject({
        created: true,
        commitSha: COMMIT_SHA,
        treeSha: TREE_SHA,
        candidateTraces: published.candidateTraces,
      });
      expect(revalidated.snapshotId).not.toBe(published.snapshotId);
      expect(await snapshotTree(clientTree)).toBe(beforeClientTree);
    } finally {
      await database.close();
    }
  }, 120_000);
});
