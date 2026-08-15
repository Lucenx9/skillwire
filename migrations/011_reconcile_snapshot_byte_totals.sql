-- Reconcile legacy decoded-payload totals to immutable canonical revision bytes.
--
-- Before migration 011, native ingestion stored the UTF-8 byte length of each
-- observed revision's instructions plus resources. Migration 006 and the v0.2.0
-- restore gate instead interpreted decoded_bytes as canonical revision bytes.
-- Both values are derived from immutable catalog objects. Accept only either
-- exact representation, record the transition, and make canonical bytes the
-- sole stored representation after this migration.

ALTER TABLE external_source_snapshots
  DISABLE TRIGGER external_snapshots_immutable;

CREATE TABLE external_snapshot_byte_total_reconciliations (
  snapshot_id uuid PRIMARY KEY
    REFERENCES external_source_snapshots(id) ON DELETE RESTRICT,
  prior_decoded_bytes bigint NOT NULL CHECK (prior_decoded_bytes >= 0),
  legacy_payload_decoded_bytes bigint NOT NULL
    CHECK (legacy_payload_decoded_bytes >= 0),
  reconciled_decoded_bytes bigint NOT NULL
    CHECK (reconciled_decoded_bytes >= 0),
  prior_representation text NOT NULL
    CHECK (prior_representation IN ('canonical', 'legacy-payload')),
  migration_version text NOT NULL DEFAULT '011'
    CHECK (migration_version = '011'),
  reconciled_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (
    (prior_representation = 'canonical'
      AND prior_decoded_bytes = reconciled_decoded_bytes)
    OR
    (prior_representation = 'legacy-payload'
      AND prior_decoded_bytes = legacy_payload_decoded_bytes)
  )
);

COMMENT ON TABLE external_snapshot_byte_total_reconciliations IS
  'Append-only migration-011 evidence for exact legacy-payload to canonical snapshot byte-total reconciliation.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM external_content_objects content
    WHERE content.byte_length <> octet_length(content.content)
       OR content.sha256 <>
          encode(sha256(convert_to(content.content, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'snapshot byte-total reconciliation found malformed content objects';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM external_skill_revisions revision
    WHERE revision.bundle_sha256 <>
          encode(sha256(convert_to(revision.canonical_bytes, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'snapshot byte-total reconciliation found malformed canonical revisions';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM external_skill_revisions revision
    LEFT JOIN external_content_objects instructions
      ON instructions.sha256=revision.instructions_sha256
    LEFT JOIN external_content_objects license
      ON license.sha256=revision.license_sha256
    LEFT JOIN external_content_objects notice
      ON notice.sha256=revision.notice_sha256
    WHERE instructions.sha256 IS NULL
       OR instructions.kind<>'instructions'
       OR license.sha256 IS NULL
       OR license.kind<>'license'
       OR revision.notice_sha256 IS NOT NULL
          AND (notice.sha256 IS NULL OR notice.kind<>'notice')
       OR EXISTS (
         SELECT 1
         FROM external_revision_resources resource
         LEFT JOIN external_content_objects content
           ON content.sha256=resource.content_sha256
         WHERE resource.revision_id=revision.id
           AND (content.sha256 IS NULL
             OR content.kind<>'resource'
             OR content.byte_length<>resource.byte_length)
       )
  ) THEN
    RAISE EXCEPTION 'snapshot byte-total reconciliation found malformed catalog objects';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM external_snapshot_skill_observations observation
    LEFT JOIN external_skill_revisions revision
      ON revision.id=observation.revision_id
    LEFT JOIN external_import_candidates candidate
      ON candidate.id=observation.candidate_id
    WHERE (observation.revision_id IS NULL AND (
             observation.result NOT IN ('missing','quarantined')
             OR observation.observed_content_identity_sha256 IS NOT NULL
           ))
       OR (observation.revision_id IS NOT NULL AND (
             revision.id IS NULL
             OR candidate.id IS NULL
             OR observation.result NOT IN ('published','reused')
             OR observation.skill_identity_id <> revision.skill_identity_id
             OR candidate.snapshot_id <> observation.snapshot_id
             OR candidate.published_revision_id IS NOT NULL
                AND candidate.published_revision_id <> observation.revision_id
             OR candidate.skill_identity_id IS NOT NULL
                AND candidate.skill_identity_id <> observation.skill_identity_id
             OR observation.observed_content_identity_sha256 IS DISTINCT FROM
                revision.content_identity_sha256
           ))
  ) THEN
    RAISE EXCEPTION 'snapshot byte-total reconciliation found malformed observation attribution';
  END IF;

  IF EXISTS (
    SELECT observation.snapshot_id
    FROM external_snapshot_skill_observations observation
    WHERE observation.revision_id IS NOT NULL
    GROUP BY observation.snapshot_id
    HAVING count(*) <> count(DISTINCT observation.revision_id)
  ) THEN
    RAISE EXCEPTION 'snapshot byte-total reconciliation found duplicate revision accounting';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM external_source_snapshots snapshot
    CROSS JOIN LATERAL (
      SELECT
        count(observation.revision_id)::bigint AS observed_revision_count,
        COALESCE(sum(octet_length(revision.canonical_bytes)::numeric), 0)
          AS canonical_total,
        COALESCE(
          sum(
            instructions.byte_length::numeric
            + COALESCE(resources.total_bytes, 0)
          ),
          0
        ) AS legacy_total
      FROM external_snapshot_skill_observations observation
      JOIN external_skill_revisions revision
        ON revision.id=observation.revision_id
      JOIN external_content_objects instructions
        ON instructions.sha256=revision.instructions_sha256
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(resource.byte_length::numeric), 0) AS total_bytes
        FROM external_revision_resources resource
        WHERE resource.revision_id=revision.id
      ) resources ON true
      WHERE observation.snapshot_id=snapshot.id
    ) totals
    WHERE snapshot.revision_count <> totals.observed_revision_count
       OR snapshot.candidate_count <> (
            SELECT count(*) FROM external_import_candidates candidate
            WHERE candidate.snapshot_id=snapshot.id
          )
       OR snapshot.quarantine_count <> (
            SELECT count(*)
            FROM external_import_candidates candidate
            JOIN external_current_classifications current
              ON current.candidate_id=candidate.id
            WHERE candidate.snapshot_id=snapshot.id
              AND current.classification='quarantined'
          )
       OR snapshot.resource_count <> (
            SELECT count(*)
            FROM external_snapshot_skill_observations observation
            JOIN external_revision_resources resource
              ON resource.revision_id=observation.revision_id
            WHERE observation.snapshot_id=snapshot.id
          )
       OR snapshot.dependency_count <> (
            SELECT count(*)
            FROM external_snapshot_skill_observations observation
            JOIN external_revision_dependencies dependency
              ON dependency.revision_id=observation.revision_id
            WHERE observation.snapshot_id=snapshot.id
          )
       OR totals.canonical_total > 9223372036854775807::numeric
       OR totals.legacy_total > 9223372036854775807::numeric
       OR snapshot.decoded_bytes NOT IN (
            totals.canonical_total::bigint,
            totals.legacy_total::bigint
          )
  ) THEN
    RAISE EXCEPTION 'snapshot byte-total reconciliation found unsupported totals';
  END IF;
END;
$$;

CREATE TEMPORARY TABLE snapshot_byte_total_reconciliation_work
ON COMMIT DROP AS
SELECT
  snapshot.id AS snapshot_id,
  snapshot.decoded_bytes AS prior_decoded_bytes,
  totals.legacy_total::bigint AS legacy_payload_decoded_bytes,
  totals.canonical_total::bigint AS reconciled_decoded_bytes,
  CASE
    WHEN snapshot.decoded_bytes=totals.canonical_total::bigint
      THEN 'canonical'
    ELSE 'legacy-payload'
  END AS prior_representation
FROM external_source_snapshots snapshot
CROSS JOIN LATERAL (
  SELECT
    COALESCE(sum(octet_length(revision.canonical_bytes)::numeric), 0)
      AS canonical_total,
    COALESCE(
      sum(
        instructions.byte_length::numeric
        + COALESCE(resources.total_bytes, 0)
      ),
      0
    ) AS legacy_total
  FROM external_snapshot_skill_observations observation
  JOIN external_skill_revisions revision ON revision.id=observation.revision_id
  JOIN external_content_objects instructions
    ON instructions.sha256=revision.instructions_sha256
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(resource.byte_length::numeric), 0) AS total_bytes
    FROM external_revision_resources resource
    WHERE resource.revision_id=revision.id
  ) resources ON true
  WHERE observation.snapshot_id=snapshot.id
) totals;

UPDATE external_source_snapshots snapshot
SET decoded_bytes=reconciliation.reconciled_decoded_bytes
FROM snapshot_byte_total_reconciliation_work reconciliation
WHERE reconciliation.snapshot_id=snapshot.id;
SET CONSTRAINTS external_snapshot_finalization_required IMMEDIATE;
ALTER TABLE external_source_snapshots
  ENABLE TRIGGER external_snapshots_immutable;

INSERT INTO external_snapshot_byte_total_reconciliations (
  snapshot_id,prior_decoded_bytes,legacy_payload_decoded_bytes,
  reconciled_decoded_bytes,prior_representation
)
SELECT
  snapshot_id,prior_decoded_bytes,legacy_payload_decoded_bytes,
  reconciled_decoded_bytes,prior_representation
FROM snapshot_byte_total_reconciliation_work;

CREATE TRIGGER external_snapshot_byte_total_reconciliations_immutable
  BEFORE UPDATE OR DELETE ON external_snapshot_byte_total_reconciliations
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_snapshot_byte_total_reconciliations_truncate_rejected
  BEFORE TRUNCATE ON external_snapshot_byte_total_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_external_history_mutation();

-- Bind every post-011 snapshot to its canonical projection and immutable
-- reconciliation evidence at commit. This rejects pre-011 writers even when
-- their legacy total happens to equal the canonical total, and prevents direct
-- SQL from advancing a projection with missing or fabricated evidence.
CREATE FUNCTION validate_external_snapshot_byte_total_projection()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  totals record;
  reconciliation record;
BEGIN
  SELECT
    snapshot.revision_count,
    snapshot.candidate_count,
    snapshot.quarantine_count,
    snapshot.resource_count,
    snapshot.dependency_count,
    snapshot.decoded_bytes,
    count(observation.revision_id)::numeric AS observed_revision_count,
    count(DISTINCT observation.revision_id)::numeric
      AS distinct_observed_revision_count,
    COALESCE(sum(
      CASE WHEN observation.revision_id IS NULL THEN 0
           ELSE octet_length(revision.canonical_bytes)::numeric END
    ), 0) AS canonical_total,
    COALESCE(sum(
      CASE WHEN observation.revision_id IS NULL THEN 0
           ELSE instructions.byte_length::numeric
                + COALESCE(resources.total_bytes, 0) END
    ), 0) AS legacy_total,
    COALESCE(sum(COALESCE(resources.resource_count, 0)), 0)::numeric
      AS observed_resource_count,
    COALESCE(sum(COALESCE(dependencies.dependency_count, 0)), 0)::numeric
      AS observed_dependency_count,
    count(*) FILTER (
      WHERE (observation.revision_id IS NULL
        AND observation.snapshot_id IS NOT NULL
        AND (
          observation.result NOT IN ('missing','quarantined')
          OR observation.observed_content_identity_sha256 IS NOT NULL
        ))
        OR (observation.revision_id IS NOT NULL AND (
          revision.id IS NULL
          OR revision.bundle_sha256 <>
             encode(sha256(convert_to(revision.canonical_bytes, 'UTF8')), 'hex')
          OR instructions.sha256 IS NULL
          OR instructions.kind <> 'instructions'
          OR instructions.byte_length <> octet_length(instructions.content)
          OR instructions.sha256 <>
             encode(sha256(convert_to(instructions.content, 'UTF8')), 'hex')
          OR license.sha256 IS NULL
          OR license.kind <> 'license'
          OR license.byte_length <> octet_length(license.content)
          OR license.sha256 <>
             encode(sha256(convert_to(license.content, 'UTF8')), 'hex')
          OR revision.notice_sha256 IS NOT NULL AND (
            notice.sha256 IS NULL
            OR notice.kind <> 'notice'
            OR notice.byte_length <> octet_length(notice.content)
            OR notice.sha256 <>
               encode(sha256(convert_to(notice.content, 'UTF8')), 'hex')
          )
          OR candidate.id IS NULL
          OR candidate.snapshot_id <> observation.snapshot_id
          OR candidate.skill_identity_id IS NOT NULL
             AND candidate.skill_identity_id <> observation.skill_identity_id
          OR candidate.published_revision_id IS NOT NULL
             AND candidate.published_revision_id <> observation.revision_id
          OR observation.result NOT IN ('published','reused')
          OR observation.skill_identity_id <> revision.skill_identity_id
          OR observation.observed_content_identity_sha256 IS DISTINCT FROM
             revision.content_identity_sha256
          OR COALESCE(resources.invalid_object_count, 0) <> 0
        ))
    )::numeric AS invalid_object_count
  INTO totals
  FROM external_source_snapshots snapshot
  LEFT JOIN external_snapshot_skill_observations observation
    ON observation.snapshot_id=snapshot.id
  LEFT JOIN external_skill_revisions revision
    ON revision.id=observation.revision_id
  LEFT JOIN external_content_objects instructions
    ON instructions.sha256=revision.instructions_sha256
  LEFT JOIN external_content_objects license
    ON license.sha256=revision.license_sha256
  LEFT JOIN external_content_objects notice
    ON notice.sha256=revision.notice_sha256
  LEFT JOIN external_import_candidates candidate
    ON candidate.id=observation.candidate_id
  LEFT JOIN LATERAL (
    SELECT
      count(*)::numeric AS resource_count,
      COALESCE(sum(resource.byte_length::numeric), 0) AS total_bytes,
      count(*) FILTER (
        WHERE content.sha256 IS NULL
           OR content.kind <> 'resource'
           OR content.byte_length <> resource.byte_length
           OR content.byte_length <> octet_length(content.content)
           OR content.sha256 <>
              encode(sha256(convert_to(content.content, 'UTF8')), 'hex')
      )::numeric AS invalid_object_count
    FROM external_revision_resources resource
    LEFT JOIN external_content_objects content
      ON content.sha256=resource.content_sha256
    WHERE resource.revision_id=revision.id
  ) resources ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::numeric AS dependency_count
    FROM external_revision_dependencies dependency
    WHERE dependency.revision_id=revision.id
  ) dependencies ON true
  WHERE snapshot.id=NEW.id
  GROUP BY snapshot.id;

  SELECT * INTO reconciliation
  FROM external_snapshot_byte_total_reconciliations
  WHERE snapshot_id=NEW.id;

  IF totals IS NULL
     OR reconciliation IS NULL
     OR totals.observed_revision_count <>
        totals.distinct_observed_revision_count
     OR totals.revision_count <> totals.observed_revision_count
     OR totals.candidate_count <> (
          SELECT count(*) FROM external_import_candidates candidate
          WHERE candidate.snapshot_id=NEW.id
        )
     OR totals.quarantine_count <> (
          SELECT count(*)
          FROM external_import_candidates candidate
          JOIN external_current_classifications current
            ON current.candidate_id=candidate.id
          WHERE candidate.snapshot_id=NEW.id
            AND current.classification='quarantined'
        )
     OR totals.resource_count <> totals.observed_resource_count
     OR totals.dependency_count <> totals.observed_dependency_count
     OR totals.invalid_object_count <> 0
     OR totals.canonical_total > 9223372036854775807::numeric
     OR totals.legacy_total > 9223372036854775807::numeric
     OR totals.decoded_bytes <> totals.canonical_total
     OR reconciliation.migration_version <> '011'
     OR reconciliation.reconciled_decoded_bytes <> totals.canonical_total
     OR reconciliation.reconciled_decoded_bytes <> totals.decoded_bytes
     OR reconciliation.legacy_payload_decoded_bytes <> totals.legacy_total
     OR reconciliation.prior_representation='canonical'
        AND reconciliation.prior_decoded_bytes <> totals.canonical_total
     OR reconciliation.prior_representation='legacy-payload'
        AND reconciliation.prior_decoded_bytes <> totals.legacy_total
     OR reconciliation.prior_representation NOT IN
        ('canonical','legacy-payload') THEN
    RAISE EXCEPTION 'snapshot byte-total projection is invalid';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER external_snapshot_byte_total_projection_valid
  AFTER INSERT OR UPDATE ON external_source_snapshots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION validate_external_snapshot_byte_total_projection();

DO $$
BEGIN
  IF (SELECT count(*) FROM external_snapshot_byte_total_reconciliations) <>
     (SELECT count(*) FROM external_source_snapshots)
     OR EXISTS (
       SELECT 1
       FROM external_source_snapshots snapshot
       JOIN external_snapshot_byte_total_reconciliations reconciliation
         ON reconciliation.snapshot_id=snapshot.id
       WHERE snapshot.decoded_bytes <> reconciliation.reconciled_decoded_bytes
     ) THEN
    RAISE EXCEPTION 'snapshot byte-total reconciliation is incomplete';
  END IF;
END;
$$;
