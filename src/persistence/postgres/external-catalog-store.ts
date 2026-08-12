import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  AdministrativeCandidate,
  AdministrativeCandidatePage,
  ClassificationChange,
  ExternalCatalogStore,
  PublishExternalSnapshotInput,
  PublishedExternalSnapshot,
} from "../../application/ports/external-catalog-store.js";
import type { OperationContext } from "../../application/ports/github-source-provider.js";
import type { SyncLease } from "../../application/ports/sync-lease-store.js";
import { assertRequestActive } from "../../application/request-execution.js";
import {
  canonicalJson,
  sha256Hex,
} from "../../domain/catalog/canonical-revision.js";
import {
  applyCandidateTransition,
  stableFindings,
} from "../../domain/external-catalog/candidate-policy.js";
import { hashExternalAdvisoryEvent } from "../../domain/external-catalog/external-advisory-chain.js";
import type {
  CandidateClassification,
  CandidateTraceResult,
  ClassificationActor,
  ExternalCandidateInput,
  ExternalSkillRevision,
  ExternalValidationReasonCode,
  GitHubRepositoryIdentity,
  ImportTraceResult,
} from "../../domain/external-catalog/types.js";
import { assertLeaseHeld } from "./lease-fencing.js";
import { PostgresGitHubSourceStore } from "./github-source-store.js";
import { requestTransaction } from "./request-transaction.js";

interface ExistingSnapshotRow {
  readonly id: string;
  readonly tree_sha: string;
  readonly manifest_version: string;
  readonly revision_count: number;
  readonly adapter_kind: "claude-plugin" | "nested-skill";
  readonly resource_count: number;
}

interface TraceRow {
  readonly skill_path: string;
  readonly name: string;
  readonly revision: string;
  readonly bundle_sha256: string;
  readonly result: "published" | "reused";
}

interface CandidateTraceRow {
  readonly candidate_id: string;
  readonly skill_path: string;
  readonly display_name: string;
  readonly classification: CandidateClassification;
  readonly reason_codes: string[] | null;
  readonly revision: string | null;
  readonly bundle_sha256: string | null;
  readonly result: "published" | "reused" | "quarantined";
}

async function insertContent(
  client: PoolClient,
  sha256: string,
  kind: "instructions" | "resource" | "license" | "notice",
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
  if (row?.content !== content || row.byte_length !== byteLength) {
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

async function existingCandidateTraces(
  client: PoolClient,
  snapshotId: string,
): Promise<readonly CandidateTraceResult[]> {
  const result = await client.query<CandidateTraceRow>(
    `
      SELECT c.id AS candidate_id, c.skill_document_path AS skill_path,
             c.display_name, COALESCE(rc.classification, cc.classification) AS classification,
             array_remove(array_agg(DISTINCT f.reason_code), NULL) AS reason_codes,
             r.revision, r.bundle_sha256,
             COALESCE(o.result, 'quarantined') AS result
      FROM external_import_candidates c
      JOIN external_current_classifications cc ON cc.candidate_id = c.id
      LEFT JOIN external_verification_reports vr ON vr.candidate_id = c.id
      LEFT JOIN external_validation_findings f ON f.report_id = vr.id
      LEFT JOIN external_snapshot_skill_observations o ON o.candidate_id = c.id
      LEFT JOIN external_skill_revisions r ON r.id = o.revision_id
      LEFT JOIN external_current_revision_classifications rc ON rc.revision_id = r.id
      WHERE c.snapshot_id = $1
      GROUP BY c.id, c.skill_document_path, c.display_name,
               COALESCE(rc.classification, cc.classification),
               r.revision, r.bundle_sha256, o.result
      ORDER BY skill_path
    `,
    [snapshotId],
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    skillPath: row.skill_path,
    skillName: row.display_name,
    classification: row.classification,
    result: row.result,
    reasonCodes: (
      row.reason_codes ?? []
    ).toSorted() as ExternalValidationReasonCode[],
    ...(row.revision === null ? {} : { revision: row.revision }),
    ...(row.bundle_sha256 === null ? {} : { bundleSha256: row.bundle_sha256 }),
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

  listSources(
    ...args: Parameters<PostgresGitHubSourceStore["listSources"]>
  ): ReturnType<PostgresGitHubSourceStore["listSources"]> {
    return this.#sources.listSources(...args);
  }

  listAdministrativeSources(
    ...args: Parameters<PostgresGitHubSourceStore["listAdministrativeSources"]>
  ): ReturnType<PostgresGitHubSourceStore["listAdministrativeSources"]> {
    return this.#sources.listAdministrativeSources(...args);
  }

  async publishSnapshot(
    input: PublishExternalSnapshotInput,
    context: OperationContext = {},
  ): Promise<PublishedExternalSnapshot> {
    if (input.revisions.length > 256) {
      throw new Error("INVALID_REVISION_BATCH");
    }
    const candidates = normalizedCandidates(input);
    if (candidates.length === 0 || candidates.length > 512) {
      throw new Error("INVALID_CANDIDATE_BATCH");
    }
    return requestTransaction(this.pool, context, async (client) => {
      if (input.lease !== undefined) await assertLeaseHeld(client, input.lease);
      const advisoryHead = await client.query<{ last_event_sha256: string }>(
        "SELECT last_event_sha256 FROM external_advisory_chain_head WHERE singleton FOR UPDATE",
      );
      const preSyncAdvisoryHead = advisoryHead.rows[0]?.last_event_sha256;
      if (
        preSyncAdvisoryHead === undefined ||
        (input.expectedAdvisoryChainHead !== undefined &&
          input.expectedAdvisoryChainHead !== preSyncAdvisoryHead)
      ) {
        throw new Error("ADVISORY_CHAIN_STALE");
      }
      if (input.observedRepository !== undefined) {
        await this.#refreshSourceIdentity(
          client,
          input.sourceId,
          input.observedRepository,
          input.observedMetadataCache,
        );
      }
      const duplicate = await client.query<ExistingSnapshotRow>(
        `
          SELECT id, tree_sha, manifest_version, revision_count, adapter_kind,
                 resource_count
          FROM external_source_snapshots
          WHERE source_id = $1 AND commit_sha = $2
        `,
        [input.sourceId, input.commitSha],
      );
      const existing = duplicate.rows[0];
      if (existing !== undefined) {
        const priorCandidateTraces = await existingCandidateTraces(
          client,
          existing.id,
        );
        if (
          existing.tree_sha !== input.treeSha ||
          existing.manifest_version !== input.manifestVersion ||
          existing.adapter_kind !== (input.adapterKind ?? "claude-plugin") ||
          existing.revision_count !== input.revisions.length ||
          priorCandidateTraces.length !== candidates.length
        ) {
          throw new Error("PUBLICATION_CONFLICT");
        }
        if (input.reverifyCandidateId !== undefined) {
          await this.#reverifyCandidate(
            client,
            existing.id,
            input.reverifyCandidateId,
            candidates,
          );
        }
        const traces = await existingTraces(client, existing.id);
        const candidateTraces = await existingCandidateTraces(
          client,
          existing.id,
        );
        if (traces.length > 0) {
          await this.#recordMissingAndAdvisories(
            client,
            input.sourceId,
            undefined,
            candidates,
          );
          for (const candidate of candidateTraces) {
            if (candidate.revision !== undefined) {
              await this.#restoreAvailabilityIfNeeded(
                client,
                candidate.candidateId,
              );
            }
          }
          await client.query(
            "UPDATE github_sources SET current_published_snapshot_id=$2, source_classification='verified' WHERE id=$1",
            [input.sourceId, existing.id],
          );
        } else {
          await client.query(
            "UPDATE github_sources SET source_classification='quarantined' WHERE id=$1",
            [input.sourceId],
          );
        }
        if (input.lease !== undefined)
          await assertLeaseHeld(client, input.lease);
        return {
          snapshotId: existing.id,
          sourceId: input.sourceId,
          commitSha: input.commitSha,
          treeSha: existing.tree_sha,
          resourceCount: existing.resource_count,
          traces,
          candidateTraces,
          created: false,
        };
      }

      const snapshotId = randomUUID();
      await client.query(
        `
          INSERT INTO external_source_snapshots (
            id, source_id, commit_sha, tree_sha, manifest_version, revision_count,
            adapter_kind, candidate_count, quarantine_count, resource_count,
            dependency_count, decoded_bytes, validation_input_sha256,
            advisory_chain_head_sha256,origin_github_repository_id,
            origin_owner,origin_repository
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                    $14,$15,$16,$17)
        `,
        [
          snapshotId,
          input.sourceId,
          input.commitSha,
          input.treeSha,
          input.manifestVersion,
          input.revisions.length,
          input.adapterKind ?? "claude-plugin",
          candidates.length,
          candidates.filter(
            ({ classification }) => classification === "quarantined",
          ).length,
          input.revisions.reduce(
            (count, revision) => count + revision.resources.length,
            0,
          ),
          input.revisions.reduce(
            (count, revision) => count + revision.dependencies.length,
            0,
          ),
          input.revisions.reduce(
            (count, revision) =>
              count +
              Buffer.byteLength(revision.instructions, "utf8") +
              revision.resources.reduce(
                (resourceCount, resource) =>
                  resourceCount + resource.byteLength,
                0,
              ),
            0,
          ),
          input.validationInputSha256 ??
            sha256Hex(
              canonicalJson({
                sourceId: input.sourceId,
                commitSha: input.commitSha,
                treeSha: input.treeSha,
                candidates: candidates.map(
                  ({ skillPath, name, classification, revision }) => ({
                    skillPath,
                    name,
                    classification,
                    contentIdentitySha256:
                      revision?.contentIdentitySha256 ?? null,
                  }),
                ),
              }),
            ),
          null,
          input.observedRepository?.repositoryId ??
            input.revisions[0]?.provenance.repositoryId,
          input.observedRepository?.owner ??
            input.revisions[0]?.provenance.owner,
          input.observedRepository?.repository ??
            input.revisions[0]?.provenance.repository,
        ],
      );

      const traces: ImportTraceResult[] = [];
      const candidateTraces: CandidateTraceResult[] = [];
      for (const candidate of candidates) {
        assertRequestActive(context);
        const candidateId = randomUUID();
        await this.#insertCandidate(client, snapshotId, candidateId, candidate);
        if (
          candidate.classification === "verified" &&
          candidate.revision !== undefined
        ) {
          const trace = await this.#publishRevision(
            client,
            snapshotId,
            input.sourceId,
            candidateId,
            candidate.revision,
          );
          traces.push(trace);
          const revisionClassification =
            await this.#ensureRevisionClassification(client, candidateId);
          await this.#restoreAvailabilityIfNeeded(client, candidateId);
          candidateTraces.push({
            candidateId,
            skillPath: candidate.skillPath,
            skillName: candidate.name,
            classification: revisionClassification,
            result: trace.result,
            reasonCodes: [],
            revision: trace.revision,
            bundleSha256: trace.bundleSha256,
          });
        } else {
          candidateTraces.push({
            candidateId,
            skillPath: candidate.skillPath,
            skillName: candidate.name,
            classification: "quarantined",
            result: "quarantined",
            reasonCodes: [
              ...new Set(candidate.findings.map(({ code }) => code)),
            ].toSorted(),
          });
        }
      }
      await this.#publishDependencies(client, snapshotId, candidates);
      if (traces.length > 0) {
        await this.#recordMissingAndAdvisories(
          client,
          input.sourceId,
          snapshotId,
          candidates,
        );
        await client.query(
          "UPDATE github_sources SET current_published_snapshot_id = $2, source_classification = 'verified' WHERE id = $1",
          [input.sourceId, snapshotId],
        );
      } else {
        await client.query(
          `UPDATE github_sources
           SET source_classification = 'quarantined',
               current_published_snapshot_id = NULL
           WHERE id = $1`,
          [input.sourceId],
        );
      }
      const finalizedAdvisoryHead = await client.query<{
        last_event_sha256: string;
      }>(
        "SELECT last_event_sha256 FROM external_advisory_chain_head WHERE singleton",
      );
      const finalHead = finalizedAdvisoryHead.rows[0]?.last_event_sha256;
      if (finalHead === undefined) throw new Error("ADVISORY_CHAIN_INVALID");
      const finalizedSnapshot = await client.query(
        `UPDATE external_source_snapshots
         SET advisory_chain_head_sha256=$2
         WHERE id=$1 AND advisory_chain_head_sha256 IS NULL`,
        [snapshotId, finalHead],
      );
      if (finalizedSnapshot.rowCount !== 1) {
        throw new Error("PUBLICATION_CONFLICT");
      }
      if (input.lease !== undefined) await assertLeaseHeld(client, input.lease);
      return {
        snapshotId,
        sourceId: input.sourceId,
        commitSha: input.commitSha,
        treeSha: input.treeSha,
        resourceCount: input.revisions.reduce(
          (count, revision) => count + revision.resources.length,
          0,
        ),
        traces: traces.toSorted((a, b) =>
          a.skillPath.localeCompare(b.skillPath, "en-US"),
        ),
        candidateTraces: candidateTraces.toSorted((a, b) =>
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
    candidateId: string,
    revision: ExternalSkillRevision,
  ): Promise<ImportTraceResult> {
    await insertContent(
      client,
      sha256Hex(revision.provenance.licenseText),
      "license",
      "text/plain",
      revision.provenance.licenseText,
    );
    if (revision.provenance.noticeText !== undefined) {
      await insertContent(
        client,
        sha256Hex(revision.provenance.noticeText),
        "notice",
        "text/plain",
        revision.provenance.noticeText,
      );
    }
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

    const root = skillRoot(revision.provenance.skillPath);
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
            invocation_mode, canonical_bytes, trust_at_publication,
            origin_owner, origin_repository, license_evidence_path,
            license_blob_sha, skill_declared_spdx_id, notice_sha256,
            notice_evidence_path, notice_blob_sha
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                    $18,$19,$20,$21,$22,$23,$24,$25)
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
          revision.provenance.owner,
          revision.provenance.repository,
          revision.provenance.licenseEvidencePath ?? null,
          revision.provenance.licenseBlobSha ?? null,
          revision.provenance.skillDeclaredSpdxId ?? null,
          revision.provenance.noticeText === undefined
            ? null
            : sha256Hex(revision.provenance.noticeText),
          revision.provenance.noticeEvidencePath ?? null,
          revision.provenance.noticeBlobSha ?? null,
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
    }
    if (revisionName === undefined || bundleSha256 === undefined) {
      throw new Error("REVISION_INSERT_FAILED");
    }
    await client.query(
      `
        INSERT INTO external_snapshot_skill_observations (
          snapshot_id, skill_identity_id, revision_id, result, candidate_id,
          observed_content_identity_sha256
        ) VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [
        snapshotId,
        storedIdentityId,
        revisionId,
        result,
        candidateId,
        revision.contentIdentitySha256,
      ],
    );
    return {
      skillPath: revision.provenance.skillPath,
      skillName: revision.name,
      result,
      revision: revisionName,
      bundleSha256,
    };
  }

  async #reverifyCandidate(
    client: PoolClient,
    snapshotId: string,
    candidateId: string,
    candidates: readonly ExternalCandidateInput[],
  ): Promise<void> {
    const state = await client.query<{
      skill_document_path: string;
      classification: CandidateClassification;
      revision_id: string | null;
    }>(
      `SELECT c.skill_document_path,cc.classification,o.revision_id
       FROM external_import_candidates c
       JOIN external_current_classifications cc ON cc.candidate_id=c.id
       LEFT JOIN external_snapshot_skill_observations o ON o.candidate_id=c.id
       WHERE c.id=$1 AND c.snapshot_id=$2
       FOR UPDATE OF cc`,
      [candidateId, snapshotId],
    );
    const row = state.rows[0];
    if (row === undefined) throw new Error("NOT_FOUND");
    const acquired = candidates.find(
      ({ skillPath }) => skillPath === row.skill_document_path,
    );
    if (acquired === undefined) throw new Error("NOT_FOUND");

    const inputSha256 = sha256Hex(
      canonicalJson({
        skillPath: acquired.skillPath,
        name: acquired.name,
        description: acquired.description,
        classification: acquired.classification,
        findings: acquired.findings,
        revision: acquired.revision?.contentIdentitySha256 ?? null,
      }),
    );
    const orderedFindings = [...acquired.findings].toSorted((left, right) => {
      const code = left.code.localeCompare(right.code, "en-US");
      return code === 0
        ? left.subjectId.localeCompare(right.subjectId, "en-US")
        : code;
    });
    const reportSha256 = sha256Hex(
      canonicalJson({
        inputSha256,
        result: acquired.classification === "verified" ? "passed" : "failed",
        findings: orderedFindings,
      }),
    );
    const reportId = randomUUID();
    const insertedReport = await client.query<{ id: string }>(
      `INSERT INTO external_verification_reports (
         id,candidate_id,policy_version,validator_version,input_sha256,
         report_sha256,result
       ) VALUES ($1,$2,'external-policy-v1','external-validator-v1',$3,$4,$5)
       ON CONFLICT (candidate_id,policy_version,validator_version,input_sha256)
       DO NOTHING
       RETURNING id`,
      [
        reportId,
        candidateId,
        inputSha256,
        reportSha256,
        acquired.classification === "verified" ? "passed" : "failed",
      ],
    );
    let storedReportId = insertedReport.rows[0]?.id;
    if (storedReportId === undefined) {
      const report = await client.query<{ id: string }>(
        `SELECT id FROM external_verification_reports
         WHERE candidate_id=$1 AND policy_version='external-policy-v1'
           AND validator_version='external-validator-v1' AND input_sha256=$2`,
        [candidateId, inputSha256],
      );
      storedReportId = report.rows[0]?.id;
    }
    if (storedReportId === undefined) throw new Error("VERIFICATION_FAILED");
    if (acquired.classification !== "verified") return;
    if (row.revision_id === null) throw new Error("PUBLICATION_CONFLICT");
    if (row.classification === "verified" || row.classification === "curated")
      return;
    applyCandidateTransition(row.classification, "verified", "verifier");
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO external_classification_events (
         id,candidate_id,previous_classification,next_classification,
         actor_kind,actor_id,reason_code,report_id
       ) VALUES ($1,$2,$3,'verified','verifier','automatic-verifier',
                 'AUTOMATIC_VERIFICATION_PASSED',$4)`,
      [eventId, candidateId, row.classification, storedReportId],
    );
    await client.query(
      `UPDATE external_current_classifications SET
         classification='verified',latest_event_id=$2,updated_at=statement_timestamp()
       WHERE candidate_id=$1`,
      [candidateId, eventId],
    );
    await client.query(
      `UPDATE external_current_revision_classifications SET
         classification='verified',latest_event_id=$2,updated_at=statement_timestamp()
       WHERE revision_id=$1`,
      [row.revision_id, eventId],
    );
  }

  async #publishDependencies(
    client: PoolClient,
    snapshotId: string,
    candidates: readonly ExternalCandidateInput[],
  ): Promise<void> {
    for (const candidate of candidates) {
      if (candidate.revision === undefined) continue;
      const source = await client.query<{
        revision_id: string;
        instructions_sha256: string;
      }>(
        `SELECT o.revision_id, r.instructions_sha256
         FROM external_snapshot_skill_observations o
         JOIN external_skill_revisions r ON r.id=o.revision_id
         JOIN external_import_candidates c ON c.id=o.candidate_id
         WHERE o.snapshot_id=$1 AND c.skill_document_path=$2`,
        [snapshotId, candidate.skillPath],
      );
      const sourceRow = source.rows[0];
      if (sourceRow === undefined) throw new Error("PUBLICATION_CONFLICT");
      for (const dependency of candidate.revision.dependencies) {
        const target = await client.query<{
          revision_id: string;
          skill_identity_id: string;
        }>(
          `SELECT o.revision_id, o.skill_identity_id
           FROM external_snapshot_skill_observations o
           JOIN external_import_candidates c ON c.id=o.candidate_id
           WHERE o.snapshot_id=$1 AND c.normalized_name=$2
             AND o.revision_id IS NOT NULL`,
          [snapshotId, dependency.skillName],
        );
        const targetRow = target.rows[0];
        if (targetRow === undefined) throw new Error("DEPENDENCY_MISSING");
        const targetRevision = await client.query<{
          catalog_skill_id: string;
          revision: string;
        }>(
          `SELECT i.catalog_skill_id,r.revision
           FROM external_skill_revisions r
           JOIN external_skill_identities i ON i.id=r.skill_identity_id
           WHERE r.id=$1`,
          [targetRow.revision_id],
        );
        const targetRevisionRow = targetRevision.rows[0];
        if (
          targetRevisionRow === undefined ||
          (dependency.targetSkillId !== undefined &&
            dependency.targetSkillId !== targetRevisionRow.catalog_skill_id) ||
          (dependency.targetRevision !== undefined &&
            dependency.targetRevision !== targetRevisionRow.revision)
        ) {
          throw new Error("PUBLICATION_CONFLICT");
        }
        const inserted = await client.query(
          `INSERT INTO external_revision_dependencies (
             revision_id,target_skill_name,target_skill_identity_id,target_revision_id,
             required,evidence_kind,evidence_locator,evidence_source_sha256
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (revision_id,target_skill_name) DO NOTHING`,
          [
            sourceRow.revision_id,
            dependency.skillName,
            targetRow.skill_identity_id,
            targetRow.revision_id,
            dependency.required,
            dependency.evidenceKind,
            dependency.evidenceLocator,
            sourceRow.instructions_sha256,
          ],
        );
        if (inserted.rowCount === 0) {
          const existing = await client.query<{
            target_skill_identity_id: string;
            target_revision_id: string;
            required: boolean;
            evidence_kind: string;
            evidence_locator: string;
            evidence_source_sha256: string;
          }>(
            `SELECT target_skill_identity_id,target_revision_id,required,evidence_kind,
                    evidence_locator,evidence_source_sha256
             FROM external_revision_dependencies
             WHERE revision_id=$1 AND target_skill_name=$2`,
            [sourceRow.revision_id, dependency.skillName],
          );
          const row = existing.rows[0];
          if (
            row?.target_skill_identity_id !== targetRow.skill_identity_id ||
            row.target_revision_id !== targetRow.revision_id ||
            row.required !== dependency.required ||
            row.evidence_kind !== dependency.evidenceKind ||
            row.evidence_locator !== dependency.evidenceLocator ||
            row.evidence_source_sha256 !== sourceRow.instructions_sha256
          ) {
            throw new Error("PUBLICATION_CONFLICT");
          }
        }
      }
    }
  }

  async #ensureRevisionClassification(
    client: PoolClient,
    candidateId: string,
  ): Promise<"verified" | "quarantined" | "curated"> {
    const inserted = await client.query<{
      revision_id: string;
      classification: "verified" | "quarantined" | "curated";
    }>(
      `
        INSERT INTO external_current_revision_classifications (
          revision_id,classification,latest_event_id
        )
        SELECT o.revision_id,cc.classification,cc.latest_event_id
        FROM external_snapshot_skill_observations o
        JOIN external_current_classifications cc ON cc.candidate_id=o.candidate_id
        WHERE o.candidate_id=$1 AND o.revision_id IS NOT NULL
        ON CONFLICT (revision_id) DO NOTHING
        RETURNING revision_id,classification
      `,
      [candidateId],
    );
    const created = inserted.rows[0];
    if (created !== undefined) return created.classification;
    const existing = await client.query<{
      classification: "verified" | "quarantined" | "curated";
    }>(
      `SELECT rc.classification
       FROM external_current_revision_classifications rc
       JOIN external_snapshot_skill_observations o ON o.revision_id=rc.revision_id
       WHERE o.candidate_id=$1`,
      [candidateId],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new Error("PUBLICATION_CONFLICT");
    return row.classification;
  }

  async #restoreAvailabilityIfNeeded(
    client: PoolClient,
    candidateId: string,
  ): Promise<void> {
    const result = await client.query<{
      revision_id: string;
      status: string | null;
    }>(
      `SELECT o.revision_id,
              (SELECT e.advisory_status FROM external_revision_advisory_events e
               WHERE e.revision_id=o.revision_id ORDER BY e.sequence DESC LIMIT 1) AS status
       FROM external_snapshot_skill_observations o
       WHERE o.candidate_id=$1 AND o.revision_id IS NOT NULL`,
      [candidateId],
    );
    const row = result.rows[0];
    if (row?.status === "unavailable") {
      await appendAdvisory(
        client,
        row.revision_id,
        "availability",
        "available",
        "UPSTREAM_SKILL_RESTORED",
      );
    }
  }

  async #insertCandidate(
    client: PoolClient,
    snapshotId: string,
    candidateId: string,
    candidate: ExternalCandidateInput,
  ): Promise<void> {
    const root = skillRoot(candidate.skillPath);
    await client.query(
      `
        INSERT INTO external_import_candidates (
          id, snapshot_id, adapter_kind, normalized_skill_root, normalized_name,
          display_name, description, skill_document_path, source_path_sha256
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        candidateId,
        snapshotId,
        candidate.adapterKind,
        root,
        candidate.name.toLowerCase(),
        candidate.name,
        candidate.description,
        candidate.skillPath,
        sha256Hex(candidate.skillPath),
      ],
    );
    const inputSha256 = sha256Hex(
      canonicalJson({
        skillPath: candidate.skillPath,
        name: candidate.name,
        description: candidate.description,
        classification: candidate.classification,
        findings: candidate.findings,
        revision: candidate.revision?.contentIdentitySha256 ?? null,
      }),
    );
    const reportId = randomUUID();
    const orderedFindings = [...candidate.findings].toSorted((left, right) => {
      const code = left.code.localeCompare(right.code, "en-US");
      return code === 0
        ? left.subjectId.localeCompare(right.subjectId, "en-US")
        : code;
    });
    const reportSha256 = sha256Hex(
      canonicalJson({
        inputSha256,
        result: candidate.classification === "verified" ? "passed" : "failed",
        findings: orderedFindings,
      }),
    );
    await client.query(
      `
        INSERT INTO external_verification_reports (
          id, candidate_id, policy_version, validator_version,
          input_sha256, report_sha256, result
        ) VALUES ($1,$2,'external-policy-v1','external-validator-v1',$3,$4,$5)
      `,
      [
        reportId,
        candidateId,
        inputSha256,
        reportSha256,
        candidate.classification === "verified" ? "passed" : "failed",
      ],
    );
    for (const [ordinal, finding] of orderedFindings.entries()) {
      await client.query(
        `
          INSERT INTO external_validation_findings (
            id, report_id, ordinal, reason_code, severity, subject_kind,
            subject_locator_sha256, safe_context
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb)
        `,
        [
          randomUUID(),
          reportId,
          ordinal,
          finding.code,
          finding.severity,
          finding.subjectKind,
          sha256Hex(finding.subjectId),
        ],
      );
    }
    const discoveredEventId = randomUUID();
    await client.query(
      `
        INSERT INTO external_classification_events (
          id, candidate_id, previous_classification, next_classification,
          actor_kind, actor_id, reason_code, report_id
        ) VALUES ($1,$2,NULL,'discovered','synchronization','source-sync',
                  'CANDIDATE_DISCOVERED',NULL)
      `,
      [discoveredEventId, candidateId],
    );
    const eventId = randomUUID();
    await client.query(
      `
        INSERT INTO external_classification_events (
          id, candidate_id, previous_classification, next_classification,
          actor_kind, actor_id, reason_code, report_id
        ) VALUES ($1,$2,'discovered',$3,'verifier','automatic-verifier',$4,$5)
      `,
      [
        eventId,
        candidateId,
        candidate.classification,
        candidate.classification === "verified"
          ? "AUTOMATIC_VERIFICATION_PASSED"
          : (orderedFindings[0]?.code ?? "SKILL_SCHEMA_INVALID"),
        reportId,
      ],
    );
    await client.query(
      `INSERT INTO external_current_classifications (
         candidate_id, classification, latest_event_id
       ) VALUES ($1,$2,$3)`,
      [candidateId, candidate.classification, eventId],
    );
  }

  async #recordMissingAndAdvisories(
    client: PoolClient,
    sourceId: string,
    snapshotId: string | undefined,
    candidates: readonly ExternalCandidateInput[],
  ): Promise<void> {
    const current = await client.query<{
      current_published_snapshot_id: string | null;
    }>(
      "SELECT current_published_snapshot_id FROM github_sources WHERE id = $1 FOR UPDATE",
      [sourceId],
    );
    const previousSnapshotId = current.rows[0]?.current_published_snapshot_id;
    if (previousSnapshotId === null || previousSnapshotId === undefined) return;
    const roots = new Set(
      candidates.map(({ skillPath }) => skillRoot(skillPath)),
    );
    const previous = await client.query<{
      skill_identity_id: string;
      normalized_skill_root: string;
      revision_id: string;
      advisory_status: string | null;
    }>(
      `
        SELECT o.skill_identity_id, i.normalized_skill_root, o.revision_id,
               (SELECT e.advisory_status
                FROM external_revision_advisory_events e
                WHERE e.revision_id=o.revision_id
                ORDER BY e.sequence DESC LIMIT 1) AS advisory_status
        FROM external_snapshot_skill_observations o
        JOIN external_skill_identities i ON i.id = o.skill_identity_id
        WHERE o.snapshot_id = $1 AND o.revision_id IS NOT NULL
      `,
      [previousSnapshotId],
    );
    for (const row of previous.rows) {
      if (roots.has(row.normalized_skill_root)) continue;
      if (snapshotId !== undefined) {
        await client.query(
          `
            INSERT INTO external_snapshot_skill_observations (
              snapshot_id, skill_identity_id, revision_id, result
            ) VALUES ($1,$2,NULL,'missing')
            ON CONFLICT DO NOTHING
          `,
          [snapshotId, row.skill_identity_id],
        );
      }
      if (
        row.advisory_status === "unavailable" ||
        row.advisory_status === "revoked"
      ) {
        continue;
      }
      await appendAdvisory(
        client,
        row.revision_id,
        "availability",
        "unavailable",
        "UPSTREAM_SKILL_REMOVED",
      );
    }
  }

  refreshSourceIdentity(
    sourceId: string,
    repository: GitHubRepositoryIdentity,
    context: OperationContext = {},
  ): Promise<void> {
    return requestTransaction(this.pool, context, async (client) => {
      await this.#refreshSourceIdentity(client, sourceId, repository);
    });
  }

  async #refreshSourceIdentity(
    client: PoolClient,
    sourceId: string,
    repository: GitHubRepositoryIdentity,
    metadataCache?: PublishExternalSnapshotInput["observedMetadataCache"],
  ): Promise<void> {
    const result = await client.query<{ github_repository_id: string }>(
      "SELECT github_repository_id FROM github_sources WHERE id = $1 FOR UPDATE",
      [sourceId],
    );
    if (
      Number(result.rows[0]?.github_repository_id) !== repository.repositoryId
    ) {
      throw new Error("SOURCE_IDENTITY_MISMATCH");
    }
    const metadataAssignment =
      metadataCache === undefined
        ? ""
        : ", metadata_etag=$5, metadata_cache_sha256=$6";
    await client.query(
      `UPDATE github_sources SET owner=$2, repository=$3,
         normalized_owner=lower($2), normalized_repository=lower($3),
         default_branch=$4, last_observed_at=statement_timestamp(),
         unavailable_confirmation_count=0, unavailable_first_observed_at=NULL,
         unavailable_last_observed_at=NULL${metadataAssignment}
       WHERE id=$1`,
      metadataCache === undefined
        ? [
            sourceId,
            repository.owner,
            repository.repository,
            repository.defaultBranch,
          ]
        : [
            sourceId,
            repository.owner,
            repository.repository,
            repository.defaultBranch,
            metadataCache?.etag ?? null,
            metadataCache?.bodySha256 ?? null,
          ],
    );
    await client.query(
      `INSERT INTO github_source_aliases (
         normalized_owner, normalized_repository, source_id, alias_reason
       ) VALUES (lower($1),lower($2),$3,'rename')
       ON CONFLICT (normalized_owner, normalized_repository) DO UPDATE SET
         last_observed_at=statement_timestamp()
       WHERE github_source_aliases.source_id=EXCLUDED.source_id`,
      [repository.owner, repository.repository, sourceId],
    );
  }

  listAdministrativeCandidates(
    classification?: CandidateClassification,
    context: OperationContext = {},
  ): Promise<readonly AdministrativeCandidate[]> {
    return requestTransaction(this.pool, context, async (client) => {
      const result = await client.query<{
        candidate_id: string;
        source_id: string;
        classification: CandidateClassification;
        reason_codes: string[] | null;
        revision: string | null;
      }>(
        `
          SELECT c.id AS candidate_id, s.source_id,
                 COALESCE(rc.classification,cc.classification) AS classification,
                 array_remove(array_agg(DISTINCT f.reason_code), NULL) AS reason_codes,
                 r.revision
          FROM external_import_candidates c
          JOIN external_source_snapshots s ON s.id = c.snapshot_id
          JOIN external_current_classifications cc ON cc.candidate_id = c.id
          LEFT JOIN external_verification_reports vr ON vr.candidate_id = c.id
          LEFT JOIN external_validation_findings f ON f.report_id = vr.id
          LEFT JOIN external_snapshot_skill_observations o ON o.candidate_id = c.id
          LEFT JOIN external_skill_revisions r ON r.id = o.revision_id
          LEFT JOIN external_current_revision_classifications rc ON rc.revision_id=r.id
          WHERE ($1::text IS NULL OR cc.classification = $1)
          GROUP BY c.id, s.source_id, cc.classification, rc.classification, r.revision
          ORDER BY c.id
          LIMIT 100
        `,
        [classification ?? null],
      );
      return result.rows.map((row) => ({
        candidateId: row.candidate_id,
        sourceId: row.source_id,
        classification: row.classification,
        reasonCodes: (row.reason_codes ?? []).toSorted(),
        ...(row.revision === null ? {} : { revision: row.revision }),
      }));
    });
  }

  listAdministrativeCandidatesPage(
    options: {
      readonly classification?: CandidateClassification | undefined;
      readonly sourceId?: string | undefined;
      readonly cursor?: string | undefined;
      readonly limit: number;
    },
    context: OperationContext = {},
  ): Promise<AdministrativeCandidatePage> {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    ) {
      throw new Error("INVALID_INPUT");
    }
    return requestTransaction(this.pool, context, async (client) => {
      const result = await client.query<{
        candidate_id: string;
        source_id: string;
        classification: CandidateClassification;
        reason_codes: string[] | null;
        revision: string | null;
      }>(
        `SELECT c.id AS candidate_id,s.source_id,
                COALESCE(rc.classification,cc.classification) AS classification,
                array_remove(array_agg(DISTINCT COALESCE(f.reason_code,
                  CASE WHEN event.reason_code='ADMIN_QUARANTINE' THEN event.reason_code END)),NULL) AS reason_codes,
                r.revision
         FROM external_import_candidates c
         JOIN external_source_snapshots s ON s.id=c.snapshot_id
         JOIN external_current_classifications cc ON cc.candidate_id=c.id
         JOIN external_classification_events event ON event.id=cc.latest_event_id
         LEFT JOIN external_verification_reports vr ON vr.candidate_id=c.id
         LEFT JOIN external_validation_findings f ON f.report_id=vr.id
         LEFT JOIN external_snapshot_skill_observations o ON o.candidate_id=c.id
         LEFT JOIN external_skill_revisions r ON r.id=o.revision_id
         LEFT JOIN external_current_revision_classifications rc ON rc.revision_id=r.id
         WHERE ($1::text IS NULL OR COALESCE(rc.classification,cc.classification)=$1)
           AND ($2::uuid IS NULL OR s.source_id=$2)
           AND ($3::uuid IS NULL OR c.id>$3)
         GROUP BY c.id,s.source_id,cc.classification,rc.classification,r.revision
         ORDER BY c.id
         LIMIT $4`,
        [
          options.classification ?? null,
          options.sourceId ?? null,
          options.cursor ?? null,
          options.limit + 1,
        ],
      );
      const hasNext = result.rows.length > options.limit;
      const rows = result.rows.slice(0, options.limit);
      return {
        items: rows.map((row) => ({
          candidateId: row.candidate_id,
          sourceId: row.source_id,
          classification: row.classification,
          reasonCodes: (row.reason_codes ?? []).toSorted(),
          ...(row.revision === null ? {} : { revision: row.revision }),
        })),
        nextCursor: hasNext ? (rows.at(-1)?.candidate_id ?? null) : null,
      };
    });
  }

  transitionCandidate(
    candidateId: string,
    next: CandidateClassification,
    actor: ClassificationActor,
    actorId: string,
    reasonCode: string,
    context: OperationContext = {},
  ): Promise<ClassificationChange> {
    return requestTransaction(this.pool, context, async (client) => {
      const state = await client.query<{
        classification: CandidateClassification;
        revision_id: string | null;
      }>(
        `SELECT cc.classification, o.revision_id
         FROM external_current_classifications cc
         JOIN external_import_candidates c ON c.id=cc.candidate_id
         LEFT JOIN external_snapshot_skill_observations o ON o.candidate_id=c.id
         WHERE cc.candidate_id=$1 FOR UPDATE OF cc`,
        [candidateId],
      );
      const row = state.rows[0];
      if (row === undefined) throw new Error("NOT_FOUND");
      if (row.classification === next) {
        return { candidateId, classification: next, changed: false };
      }
      if (next === "curated" && row.revision_id === null)
        throw new Error("NOT_VERIFIED");
      applyCandidateTransition(row.classification, next, actor);
      const eventId = randomUUID();
      await client.query(
        `INSERT INTO external_classification_events (
           id,candidate_id,previous_classification,next_classification,
           actor_kind,actor_id,reason_code
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          eventId,
          candidateId,
          row.classification,
          next,
          actor,
          actorId,
          reasonCode,
        ],
      );
      if (row.revision_id !== null) {
        await client.query(
          `UPDATE external_current_revision_classifications SET
             classification=$2,latest_event_id=$3,updated_at=statement_timestamp()
           WHERE revision_id=$1`,
          [row.revision_id, next, eventId],
        );
      }
      await client.query(
        `UPDATE external_current_classifications SET
           classification=$2, latest_event_id=$3, updated_at=statement_timestamp()
         WHERE candidate_id=$1`,
        [candidateId, next, eventId],
      );
      if (next === "curated") {
        await client.query(
          `INSERT INTO external_curation_decisions (
             id,classification_event_id,administrator_id,reason_code
           ) VALUES ($1,$2,$3,$4)`,
          [randomUUID(), eventId, actorId, reasonCode],
        );
      }
      return { candidateId, classification: next, changed: true };
    });
  }

  recordSourceUnavailable(
    sourceId: string,
    observation: {
      readonly authenticated: boolean;
      readonly uncached: boolean;
      readonly repositoryId: number;
    } = { authenticated: false, uncached: false, repositoryId: 0 },
    lease?: SyncLease,
    context: OperationContext = {},
  ): Promise<boolean> {
    return requestTransaction(this.pool, context, async (client) => {
      if (lease !== undefined) await assertLeaseHeld(client, lease);
      if (!observation.authenticated || !observation.uncached) {
        throw new Error("UNVERIFIED_SOURCE_UNAVAILABLE");
      }
      const source = await client.query<{
        github_repository_id: string;
        unavailable_confirmation_count: number;
        unavailable_first_observed_at: Date | null;
        current_published_snapshot_id: string | null;
      }>(
        `SELECT github_repository_id::text,unavailable_confirmation_count,
                unavailable_first_observed_at,
                current_published_snapshot_id
         FROM github_sources WHERE id=$1 FOR UPDATE`,
        [sourceId],
      );
      const row = source.rows[0];
      if (row === undefined) throw new Error("SOURCE_NOT_FOUND");
      if (Number(row.github_repository_id) !== observation.repositoryId) {
        throw new Error("SOURCE_IDENTITY_MISMATCH");
      }
      const nextCount = Math.min(4, row.unavailable_confirmation_count + 1);
      const confirmed =
        nextCount >= 4 &&
        row.unavailable_first_observed_at !== null &&
        row.unavailable_first_observed_at.getTime() <= Date.now() - 86_400_000;
      await client.query(
        `UPDATE github_sources SET
           unavailable_confirmation_count=$2,
           unavailable_first_observed_at=COALESCE(unavailable_first_observed_at,clock_timestamp()),
           unavailable_last_observed_at=clock_timestamp()
         WHERE id=$1`,
        [sourceId, nextCount],
      );
      const aliasAfterFirst =
        row.unavailable_first_observed_at === null
          ? false
          : (
              await client.query(
                `SELECT 1 FROM github_source_aliases
                 WHERE source_id=$1 AND last_observed_at>$2 LIMIT 1`,
                [sourceId, row.unavailable_first_observed_at],
              )
            ).rowCount === 1;
      if (aliasAfterFirst) {
        await client.query(
          `UPDATE github_sources SET unavailable_confirmation_count=0,
             unavailable_first_observed_at=NULL,unavailable_last_observed_at=NULL
           WHERE id=$1`,
          [sourceId],
        );
        return false;
      }
      if (!confirmed || row.current_published_snapshot_id === null)
        return false;
      const revisions = await client.query<{
        revision_id: string;
        status: string | null;
      }>(
        `
          SELECT o.revision_id,
                 (SELECT e.advisory_status FROM external_revision_advisory_events e
                  WHERE e.revision_id=o.revision_id ORDER BY e.sequence DESC LIMIT 1) AS status
          FROM external_snapshot_skill_observations o
          WHERE o.snapshot_id=$1 AND o.revision_id IS NOT NULL
        `,
        [row.current_published_snapshot_id],
      );
      for (const revision of revisions.rows) {
        if (revision.status === "unavailable" || revision.status === "revoked")
          continue;
        await appendAdvisory(
          client,
          revision.revision_id,
          "availability",
          "unavailable",
          "UPSTREAM_PUBLIC_SOURCE_UNAVAILABLE",
        );
      }
      if (lease !== undefined) await assertLeaseHeld(client, lease);
      return true;
    });
  }

  advisoryChainHead(context: OperationContext = {}): Promise<string> {
    return requestTransaction(this.pool, context, async (client) => {
      const result = await client.query<{ last_event_sha256: string }>(
        "SELECT last_event_sha256 FROM external_advisory_chain_head WHERE singleton",
      );
      const head = result.rows[0]?.last_event_sha256;
      if (head === undefined) throw new Error("ADVISORY_CHAIN_INVALID");
      return head;
    });
  }
}

function normalizedCandidates(
  input: PublishExternalSnapshotInput,
): readonly ExternalCandidateInput[] {
  const candidates =
    input.candidates ??
    input.revisions.map((revision) => ({
      skillPath: revision.provenance.skillPath,
      name: revision.name,
      description: revision.description,
      adapterKind: input.adapterKind ?? ("claude-plugin" as const),
      classification: "verified" as const,
      findings: [],
      revision,
    }));
  const sorted = candidates
    .map((candidate) => ({
      ...candidate,
      findings: stableFindings(candidate.findings),
    }))
    .toSorted((a, b) => a.skillPath.localeCompare(b.skillPath, "en-US"));
  const pathKeys = sorted.map(({ skillPath }) =>
    skillPath.normalize("NFKC").toLocaleLowerCase("en-US"),
  );
  if (new Set(pathKeys).size !== sorted.length) {
    throw new Error("SKILL_DUPLICATE_IDENTITY");
  }
  const nameKeys = sorted.map(({ name }) =>
    name.normalize("NFKC").toLocaleLowerCase("en-US"),
  );
  const duplicateNames = new Set(
    nameKeys.filter((name, index) => nameKeys.indexOf(name) !== index),
  );
  for (const candidate of sorted) {
    if (
      (candidate.classification === "verified") !==
      (candidate.revision !== undefined)
    ) {
      throw new Error("INVALID_CANDIDATE_RESULT");
    }
    if (
      candidate.classification === "quarantined" &&
      candidate.findings.length === 0
    ) {
      throw new Error("INVALID_CANDIDATE_RESULT");
    }
    const nameKey = candidate.name.normalize("NFKC").toLocaleLowerCase("en-US");
    if (
      duplicateNames.has(nameKey) &&
      (candidate.classification !== "quarantined" ||
        !candidate.findings.some(
          ({ code }) => code === "SKILL_DUPLICATE_IDENTITY",
        ))
    ) {
      throw new Error("SKILL_DUPLICATE_IDENTITY");
    }
  }
  return sorted;
}

async function appendAdvisory(
  client: PoolClient,
  revisionId: string,
  kind: "availability" | "security",
  status: "available" | "unavailable" | "revoked",
  reasonCode: string,
): Promise<void> {
  const head = await client.query<{
    last_sequence: string;
    last_event_sha256: string;
  }>(
    "SELECT last_sequence, last_event_sha256 FROM external_advisory_chain_head WHERE singleton FOR UPDATE",
  );
  const previous = head.rows[0];
  if (previous === undefined) throw new Error("ADVISORY_CHAIN_INVALID");
  const sequence = BigInt(previous.last_sequence) + 1n;
  const effectiveAt = new Date().toISOString();
  const eventSha256 = hashExternalAdvisoryEvent({
    sequence: sequence.toString(),
    previousEventSha256: previous.last_event_sha256,
    revisionId,
    kind,
    status,
    reasonCode,
    effectiveAt,
  });
  await client.query(
    `INSERT INTO external_revision_advisory_events (
       id,sequence,previous_event_sha256,event_sha256,revision_id,
       advisory_kind,advisory_status,reason_code,effective_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      randomUUID(),
      sequence.toString(),
      previous.last_event_sha256,
      eventSha256,
      revisionId,
      kind,
      status,
      reasonCode,
      effectiveAt,
    ],
  );
  await client.query(
    "UPDATE external_advisory_chain_head SET last_sequence=$1,last_event_sha256=$2 WHERE singleton",
    [sequence.toString(), eventSha256],
  );
}

function skillRoot(skillPath: string): string {
  return skillPath === "SKILL.md"
    ? "_root"
    : skillPath.replace(/\/SKILL\.md$/, "");
}
