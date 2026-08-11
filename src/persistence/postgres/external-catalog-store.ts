import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  ExternalCatalogStore,
  PublishExternalSnapshotInput,
  PublishedExternalSnapshot,
} from "../../application/ports/external-catalog-store.js";
import type { OperationContext } from "../../application/ports/github-source-provider.js";
import { assertRequestActive } from "../../application/request-execution.js";
import { sha256Hex } from "../../domain/catalog/canonical-revision.js";
import type {
  ExternalSkillRevision,
  ImportTraceResult,
} from "../../domain/external-catalog/types.js";
import { PostgresGitHubSourceStore } from "./github-source-store.js";
import { requestTransaction } from "./request-transaction.js";

interface ExistingSnapshotRow {
  readonly id: string;
  readonly tree_sha: string;
  readonly manifest_version: string;
  readonly revision_count: number;
}

interface TraceRow {
  readonly skill_path: string;
  readonly name: string;
  readonly revision: string;
  readonly bundle_sha256: string;
  readonly result: "published" | "reused";
}

async function insertContent(
  client: PoolClient,
  sha256: string,
  kind: "instructions" | "resource" | "license",
  mediaType: "text/markdown" | "text/plain",
  content: string,
): Promise<void> {
  const byteLength = Buffer.byteLength(content, "utf8");
  const inserted = await client.query(
    `
      INSERT INTO external_content_objects (sha256, kind, media_type, byte_length, content)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (sha256) DO NOTHING
    `,
    [sha256, kind, mediaType, byteLength, content],
  );
  if (inserted.rowCount === 1) return;
  const existing = await client.query<{
    content: string;
    kind: string;
    media_type: string;
    byte_length: number;
  }>(
    "SELECT content, kind, media_type, byte_length FROM external_content_objects WHERE sha256 = $1",
    [sha256],
  );
  const row = existing.rows[0];
  if (
    row?.content !== content ||
    row.kind !== kind ||
    row.media_type !== mediaType ||
    row.byte_length !== byteLength
  ) {
    throw new Error("HASH_MISMATCH");
  }
}

async function existingTraces(
  client: PoolClient,
  snapshotId: string,
): Promise<readonly ImportTraceResult[]> {
  const result = await client.query<TraceRow>(
    `
      SELECT r.skill_path, r.name, r.revision, r.bundle_sha256, o.result
      FROM external_snapshot_skill_observations o
      JOIN external_skill_revisions r ON r.id = o.revision_id
      WHERE o.snapshot_id = $1
      ORDER BY r.skill_path
    `,
    [snapshotId],
  );
  return result.rows.map((row) => ({
    skillPath: row.skill_path,
    skillName: row.name,
    result: row.result,
    revision: row.revision,
    bundleSha256: row.bundle_sha256,
  }));
}

export class PostgresExternalCatalogStore implements ExternalCatalogStore {
  readonly #sources: PostgresGitHubSourceStore;

  constructor(private readonly pool: Pool) {
    this.#sources = new PostgresGitHubSourceStore(pool);
  }

  registerSource(
    ...args: Parameters<PostgresGitHubSourceStore["registerSource"]>
  ): ReturnType<PostgresGitHubSourceStore["registerSource"]> {
    return this.#sources.registerSource(...args);
  }

  listSources(): ReturnType<PostgresGitHubSourceStore["listSources"]> {
    return this.#sources.listSources();
  }

  async publishSnapshot(
    input: PublishExternalSnapshotInput,
    context: OperationContext = {},
  ): Promise<PublishedExternalSnapshot> {
    if (input.revisions.length === 0 || input.revisions.length > 256) {
      throw new Error("INVALID_REVISION_BATCH");
    }
    return requestTransaction(this.pool, context, async (client) => {
      const duplicate = await client.query<ExistingSnapshotRow>(
        `
          SELECT id, tree_sha, manifest_version, revision_count
          FROM external_source_snapshots
          WHERE source_id = $1 AND commit_sha = $2
        `,
        [input.sourceId, input.commitSha],
      );
      const existing = duplicate.rows[0];
      if (existing !== undefined) {
        const traces = await existingTraces(client, existing.id);
        const requested = input.revisions
          .map((revision) => ({
            skillPath: revision.provenance.skillPath,
            skillName: revision.name,
            revision: revision.revision,
            bundleSha256: revision.bundleSha256,
          }))
          .toSorted((left, right) =>
            left.skillPath.localeCompare(right.skillPath, "en-US"),
          );
        const stored = traces.map(({ result: _result, ...trace }) => trace);
        if (
          existing.tree_sha !== input.treeSha ||
          existing.manifest_version !== input.manifestVersion ||
          existing.revision_count !== input.revisions.length ||
          JSON.stringify(stored) !== JSON.stringify(requested)
        ) {
          throw new Error("PUBLICATION_CONFLICT");
        }
        return {
          snapshotId: existing.id,
          sourceId: input.sourceId,
          commitSha: input.commitSha,
          traces,
          created: false,
        };
      }

      const snapshotId = randomUUID();
      await client.query(
        `
          INSERT INTO external_source_snapshots (
            id, source_id, commit_sha, tree_sha, manifest_version, revision_count
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          snapshotId,
          input.sourceId,
          input.commitSha,
          input.treeSha,
          input.manifestVersion,
          input.revisions.length,
        ],
      );

      const traces: ImportTraceResult[] = [];
      for (const revision of input.revisions) {
        assertRequestActive(context);
        const trace = await this.#publishRevision(
          client,
          snapshotId,
          input.sourceId,
          revision,
        );
        traces.push(trace);
      }
      await client.query(
        "UPDATE github_sources SET current_published_snapshot_id = $2 WHERE id = $1",
        [input.sourceId, snapshotId],
      );
      return {
        snapshotId,
        sourceId: input.sourceId,
        commitSha: input.commitSha,
        traces: traces.toSorted((a, b) =>
          a.skillPath.localeCompare(b.skillPath, "en-US"),
        ),
        created: true,
      };
    });
  }

  async #publishRevision(
    client: PoolClient,
    snapshotId: string,
    sourceId: string,
    revision: ExternalSkillRevision,
  ): Promise<ImportTraceResult> {
    await insertContent(
      client,
      sha256Hex(revision.provenance.licenseText),
      "license",
      "text/plain",
      revision.provenance.licenseText,
    );
    await insertContent(
      client,
      revision.instructionsSha256,
      "instructions",
      "text/markdown",
      revision.instructions,
    );
    for (const resource of revision.resources) {
      await insertContent(
        client,
        resource.sha256,
        "resource",
        resource.mediaType,
        resource.content,
      );
    }

    const root = revision.provenance.skillPath.replace(/\/SKILL\.md$/, "");
    const identityId = randomUUID();
    const identityResult = await client.query<{ id: string }>(
      `
        INSERT INTO external_skill_identities (
          id, source_id, catalog_skill_id, normalized_skill_root
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
      [identityId, sourceId, revision.skillId, root],
    );
    let storedIdentityId = identityResult.rows[0]?.id;
    if (storedIdentityId === undefined) {
      const existingIdentity = await client.query<{
        id: string;
        catalog_skill_id: string;
      }>(
        `
          SELECT id, catalog_skill_id
          FROM external_skill_identities
          WHERE source_id = $1 AND normalized_skill_root = $2
        `,
        [sourceId, root],
      );
      const row = existingIdentity.rows[0];
      if (row?.catalog_skill_id !== revision.skillId) {
        throw new Error("PUBLICATION_CONFLICT");
      }
      storedIdentityId = row.id;
    }
    const existing = await client.query<{
      id: string;
      revision: string;
      bundle_sha256: string;
    }>(
      `
        SELECT id, revision, bundle_sha256
        FROM external_skill_revisions
        WHERE skill_identity_id = $1 AND content_identity_sha256 = $2
      `,
      [storedIdentityId, revision.contentIdentitySha256],
    );
    let revisionId = existing.rows[0]?.id;
    let result: "published" | "reused" = "reused";
    let revisionName = existing.rows[0]?.revision;
    let bundleSha256 = existing.rows[0]?.bundle_sha256;
    if (revisionId === undefined) {
      revisionId = randomUUID();
      result = "published";
      revisionName = revision.revision;
      bundleSha256 = revision.bundleSha256;
      await client.query(
        `
          INSERT INTO external_skill_revisions (
            id, skill_identity_id, snapshot_id, revision, bundle_sha256,
            content_identity_sha256, name, description, skill_path, commit_sha,
            source_owner, spdx_license_id, license_sha256, instructions_sha256,
            invocation_mode, canonical_bytes, trust_at_publication
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        `,
        [
          revisionId,
          storedIdentityId,
          snapshotId,
          revision.revision,
          revision.bundleSha256,
          revision.contentIdentitySha256,
          revision.name,
          revision.description,
          revision.provenance.skillPath,
          revision.provenance.commitSha,
          revision.provenance.sourceOwner,
          revision.provenance.spdxLicenseId,
          sha256Hex(revision.provenance.licenseText),
          revision.instructionsSha256,
          revision.invocationMode,
          revision.canonicalBytes,
          revision.trustAtPublication,
        ],
      );
      for (const [ordinal, resource] of revision.resources.entries()) {
        await client.query(
          `
            INSERT INTO external_revision_resources (
              revision_id, resource_path, media_type, byte_length, content_sha256, ordinal
            ) VALUES ($1,$2,$3,$4,$5,$6)
          `,
          [
            revisionId,
            resource.path,
            resource.mediaType,
            resource.byteLength,
            resource.sha256,
            ordinal,
          ],
        );
      }
      for (const dependency of revision.dependencies) {
        await client.query(
          `
            INSERT INTO external_revision_dependencies (
              revision_id, target_skill_name, required, evidence_kind, evidence_locator
            ) VALUES ($1,$2,$3,$4,$5)
          `,
          [
            revisionId,
            dependency.skillName,
            dependency.required,
            dependency.evidenceKind,
            dependency.evidenceLocator,
          ],
        );
      }
    }
    if (revisionName === undefined || bundleSha256 === undefined) {
      throw new Error("REVISION_INSERT_FAILED");
    }
    await client.query(
      `
        INSERT INTO external_snapshot_skill_observations (
          snapshot_id, skill_identity_id, revision_id, result
        ) VALUES ($1,$2,$3,$4)
      `,
      [snapshotId, storedIdentityId, revisionId, result],
    );
    return {
      skillPath: revision.provenance.skillPath,
      skillName: revision.name,
      result,
      revision: revisionName,
      bundleSha256,
    };
  }
}
