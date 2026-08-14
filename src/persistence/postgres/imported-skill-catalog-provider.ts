import type { Pool, PoolClient } from "pg";

import type { AsyncSkillCatalogProvider } from "../../application/ports/async-skill-catalog-provider.js";
import type { RequestExecution } from "../../application/request-execution.js";
import { assertExternalRevisionIntegrity } from "../../domain/external-catalog/canonical-revision-v2.js";
import {
  verifyExternalAdvisoryChain,
  type ExternalAdvisoryChainEvent,
} from "../../domain/external-catalog/external-advisory-chain.js";
import type {
  CandidateClassification,
  ExternalAdvisoryStatus,
  ExternalDependency,
  ExternalResourceManifestEntry,
  ExternalSkillRevision,
  InvocationMode,
} from "../../domain/external-catalog/types.js";
import type {
  CatalogSkillMetadata,
  CurrentAdvisoryStatus,
  GitHubCatalogOrigin,
  SkillRevision,
} from "../../domain/catalog/types.js";
import { requestTransaction } from "./request-transaction.js";

interface RevisionRow {
  readonly id: string;
  readonly catalog_skill_id: string;
  readonly revision: string;
  readonly name: string;
  readonly description: string;
  readonly skill_path: string;
  readonly commit_sha: string;
  readonly source_owner: string;
  readonly spdx_license_id: string;
  readonly instructions_sha256: string;
  readonly bundle_sha256: string;
  readonly content_identity_sha256: string;
  readonly invocation_mode: InvocationMode;
  readonly canonical_bytes: string;
  readonly owner: string;
  readonly repository: string;
  readonly github_repository_id: string;
  readonly classification: CandidateClassification;
  readonly advisory_status: ExternalAdvisoryStatus | null;
  readonly instructions: string;
  readonly license_text: string;
  readonly license_sha256: string;
  readonly notice_sha256: string | null;
  readonly license_evidence_path: string | null;
  readonly license_blob_sha: string | null;
  readonly skill_declared_spdx_id: string | null;
  readonly notice_text: string | null;
  readonly notice_evidence_path: string | null;
  readonly notice_blob_sha: string | null;
}

interface ResourceRow {
  readonly resource_path: string;
  readonly media_type: "text/markdown" | "text/plain";
  readonly byte_length: number;
  readonly content_sha256: string;
  readonly content: string;
}

interface DependencyRow {
  readonly target_skill_name: string;
  readonly catalog_skill_id: string;
  readonly revision: string;
  readonly required: boolean;
  readonly evidence_kind: "manifest" | "frontmatter" | "explicit-invocation";
  readonly evidence_locator: string;
}

async function verifyAdvisories(client: PoolClient): Promise<void> {
  const [head, events] = await Promise.all([
    client.query<{ last_event_sha256: string }>(
      "SELECT last_event_sha256 FROM external_advisory_chain_head WHERE singleton=true",
    ),
    client.query<{
      sequence: string;
      previous_event_sha256: string;
      revision_id: string;
      advisory_kind: "availability" | "security";
      advisory_status: ExternalAdvisoryStatus;
      reason_code: string;
      effective_at: Date;
      event_sha256: string;
    }>(
      `SELECT sequence::text,previous_event_sha256,revision_id,advisory_kind,
              advisory_status,reason_code,effective_at,event_sha256
       FROM external_revision_advisory_events
       ORDER BY external_revision_advisory_events.sequence`,
    ),
  ]);
  const expectedHead = head.rows[0]?.last_event_sha256;
  if (expectedHead === undefined) throw new Error("ADVISORY_CHAIN_INVALID");
  verifyExternalAdvisoryChain(
    events.rows.map((row): ExternalAdvisoryChainEvent => ({
      sequence: row.sequence,
      previousEventSha256: row.previous_event_sha256,
      revisionId: row.revision_id,
      kind: row.advisory_kind,
      status: row.advisory_status,
      reasonCode: row.reason_code,
      effectiveAt: row.effective_at.toISOString(),
      eventSha256: row.event_sha256,
    })),
    expectedHead,
  );
}

function origin(row: RevisionRow): GitHubCatalogOrigin {
  return {
    kind: "github",
    owner: row.owner,
    repository: row.repository,
    commitSha: row.commit_sha,
    skillPath: row.skill_path,
    license: {
      spdxId: row.spdx_license_id,
      attribution: row.source_owner,
      evidenceSha256: row.license_sha256,
      ...(row.license_evidence_path === null
        ? {}
        : { evidencePath: row.license_evidence_path }),
      ...(row.notice_sha256 === null || row.notice_evidence_path === null
        ? {}
        : {
            notice: {
              sha256: row.notice_sha256,
              path: row.notice_evidence_path,
            },
          }),
    },
  };
}

const baseRevisionQuery = `
  SELECT r.id,i.catalog_skill_id,r.revision,r.name,r.description,r.skill_path,
         r.commit_sha,r.source_owner,r.spdx_license_id,r.instructions_sha256,
         r.bundle_sha256,r.content_identity_sha256,r.invocation_mode,r.canonical_bytes,
         r.license_sha256,r.notice_sha256,
         r.origin_owner AS owner,r.origin_repository AS repository,
         gs.github_repository_id::text,
         r.license_evidence_path,r.license_blob_sha,r.skill_declared_spdx_id,
         notice.content AS notice_text,r.notice_evidence_path,r.notice_blob_sha,
         rc.classification,
         advisory.advisory_status,
         instructions.content AS instructions,license.content AS license_text
  FROM external_skill_revisions r
  JOIN external_skill_identities i ON i.id=r.skill_identity_id
  JOIN github_sources gs ON gs.id=i.source_id
  JOIN external_current_revision_classifications rc ON rc.revision_id=r.id
  JOIN external_content_objects instructions ON instructions.sha256=r.instructions_sha256
  JOIN external_content_objects license ON license.sha256=r.license_sha256
  LEFT JOIN external_content_objects notice ON notice.sha256=r.notice_sha256
  LEFT JOIN LATERAL (
    SELECT e.advisory_status
    FROM external_revision_advisory_events e
    WHERE e.revision_id=r.id
    ORDER BY e.sequence DESC LIMIT 1
  ) advisory ON true
`;

function visibleClassification(
  value: CandidateClassification,
): value is "verified" | "curated" {
  return value === "verified" || value === "curated";
}

export class PostgresImportedSkillCatalogProvider implements AsyncSkillCatalogProvider {
  constructor(private readonly pool: Pool) {}

  listMetadata(
    execution: RequestExecution = {},
  ): Promise<readonly CatalogSkillMetadata[]> {
    return requestTransaction(this.pool, execution, async (client) => {
      await verifyAdvisories(client);
      const result = await client.query<RevisionRow>(
        `${baseRevisionQuery}
         JOIN external_snapshot_skill_observations observation ON observation.revision_id=r.id
         JOIN external_source_snapshots snapshot ON snapshot.id=observation.snapshot_id
         WHERE snapshot.id=gs.current_published_snapshot_id
           AND rc.classification IN ('verified','curated')
           AND COALESCE(advisory.advisory_status,'available')='available'
         ORDER BY i.catalog_skill_id,r.revision`,
      );
      return result.rows.map((row) => ({
        id: row.catalog_skill_id,
        name: row.name,
        description: row.description,
        capabilities: [row.name],
        revision: row.revision,
        trustAtPublication: "structurally-verified" as const,
        currentAdvisoryStatus: "available" as const,
        catalogOrigin: origin(row),
        currentClassification: row.classification as "verified" | "curated",
        invocationMode: row.invocation_mode,
      }));
    });
  }

  advisoryStatus(
    skillId: string,
    revision: string,
    execution: RequestExecution = {},
  ): Promise<CurrentAdvisoryStatus | undefined> {
    return requestTransaction(this.pool, execution, async (client) => {
      await verifyAdvisories(client);
      const result = await client.query<{
        classification: CandidateClassification;
        advisory_status: ExternalAdvisoryStatus | null;
      }>(
        `SELECT rc.classification,advisory.advisory_status
         FROM external_skill_revisions r
         JOIN external_skill_identities i ON i.id=r.skill_identity_id
         JOIN external_current_revision_classifications rc ON rc.revision_id=r.id
         LEFT JOIN LATERAL (
           SELECT e.advisory_status FROM external_revision_advisory_events e
           WHERE e.revision_id=r.id ORDER BY e.sequence DESC LIMIT 1
         ) advisory ON true
         WHERE i.catalog_skill_id=$1 AND r.revision=$2`,
        [skillId, revision],
      );
      const row = result.rows[0];
      if (row === undefined || !visibleClassification(row.classification)) {
        return undefined;
      }
      return row.advisory_status ?? "available";
    });
  }

  findRevision(
    skillId: string,
    revision: string,
    execution: RequestExecution = {},
  ): Promise<SkillRevision | undefined> {
    return requestTransaction(this.pool, execution, async (client) => {
      await verifyAdvisories(client);
      const result = await client.query<RevisionRow>(
        `${baseRevisionQuery}
         WHERE i.catalog_skill_id=$1 AND r.revision=$2`,
        [skillId, revision],
      );
      const row = result.rows[0];
      if (
        row === undefined ||
        !visibleClassification(row.classification) ||
        row.advisory_status === "revoked"
      ) {
        return undefined;
      }
      const [resourcesResult, dependenciesResult] = await Promise.all([
        client.query<ResourceRow>(
          `SELECT rr.resource_path,rr.media_type,rr.byte_length,rr.content_sha256,o.content
           FROM external_revision_resources rr
           JOIN external_content_objects o ON o.sha256=rr.content_sha256
           WHERE rr.revision_id=$1 ORDER BY rr.ordinal`,
          [row.id],
        ),
        client.query<DependencyRow>(
          `SELECT d.target_skill_name,i.catalog_skill_id,r.revision,d.required,
                  d.evidence_kind,d.evidence_locator
           FROM external_revision_dependencies d
           JOIN external_skill_identities i ON i.id=d.target_skill_identity_id
           JOIN external_skill_revisions r ON r.id=d.target_revision_id
           WHERE d.revision_id=$1 ORDER BY d.target_skill_name`,
          [row.id],
        ),
      ]);
      const resources: ExternalResourceManifestEntry[] =
        resourcesResult.rows.map((resource) => ({
          path: resource.resource_path,
          mediaType: resource.media_type,
          byteLength: resource.byte_length,
          sha256: resource.content_sha256,
          content: resource.content,
        }));
      const dependencies: ExternalDependency[] = dependenciesResult.rows.map(
        (dependency) => ({
          skillName: dependency.target_skill_name,
          targetSkillId: dependency.catalog_skill_id,
          targetRevision: dependency.revision,
          required: dependency.required,
          evidenceKind: dependency.evidence_kind,
          evidenceLocator: dependency.evidence_locator,
        }),
      );
      const external: ExternalSkillRevision = {
        schemaVersion: 2,
        trustAtPublication: "structurally-verified",
        skillId: row.catalog_skill_id,
        revision: row.revision,
        name: row.name,
        description: row.description,
        provenance: {
          provider: "github",
          repositoryId: Number(row.github_repository_id),
          owner: row.owner,
          repository: row.repository,
          commitSha: row.commit_sha,
          skillPath: row.skill_path,
          sourceOwner: row.source_owner,
          spdxLicenseId: row.spdx_license_id,
          licenseText: row.license_text,
          ...(row.license_evidence_path === null
            ? {}
            : { licenseEvidencePath: row.license_evidence_path }),
          ...(row.license_blob_sha === null
            ? {}
            : { licenseBlobSha: row.license_blob_sha }),
          ...(row.skill_declared_spdx_id === null
            ? {}
            : { skillDeclaredSpdxId: row.skill_declared_spdx_id }),
          ...(row.notice_text === null ? {} : { noticeText: row.notice_text }),
          ...(row.notice_evidence_path === null
            ? {}
            : { noticeEvidencePath: row.notice_evidence_path }),
          ...(row.notice_blob_sha === null
            ? {}
            : { noticeBlobSha: row.notice_blob_sha }),
        },
        invocationMode: row.invocation_mode,
        instructions: row.instructions,
        instructionsSha256: row.instructions_sha256,
        resources,
        dependencies,
        contentIdentitySha256: row.content_identity_sha256,
        bundleSha256: row.bundle_sha256,
        canonicalBytes: row.canonical_bytes,
      };
      assertExternalRevisionIntegrity(external);
      const catalogOrigin = origin(row);
      return {
        skillId: external.skillId,
        revision: external.revision,
        publishedProvenance: {
          source: {
            provider: "github",
            reference: `github:${row.github_repository_id}:${row.skill_path}`,
          },
          sourceRevision: row.commit_sha,
          owner: row.source_owner,
          license: row.spdx_license_id,
          trustAtPublication: "structurally-verified",
        },
        instructions: external.instructions,
        instructionsSha256: external.instructionsSha256,
        resourceManifest: external.resources.map(
          ({ path, mediaType, byteLength, sha256 }) => ({
            path,
            mediaType,
            byteLength,
            sha256,
          }),
        ),
        resources: external.resources,
        bundleSha256: external.bundleSha256,
        catalogOrigin,
        currentClassification: row.classification,
        invocationMode: row.invocation_mode,
        dependencies: dependencies.map((dependency) => ({
          skillId: dependency.targetSkillId ?? "",
          revision: dependency.targetRevision ?? "",
          required: dependency.required,
          evidenceKind: dependency.evidenceKind,
        })),
      };
    });
  }
}
