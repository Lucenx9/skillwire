-- Feature 002 convergence: immutable origin/legal provenance and durable sync jobs.

ALTER TABLE external_skill_revisions
  ADD COLUMN origin_owner text,
  ADD COLUMN origin_repository text,
  ADD COLUMN license_evidence_path text,
  ADD COLUMN license_blob_sha character(40),
  ADD COLUMN skill_declared_spdx_id text,
  ADD COLUMN notice_sha256 character(64) REFERENCES external_content_objects(sha256) ON DELETE RESTRICT,
  ADD COLUMN notice_evidence_path text,
  ADD COLUMN notice_blob_sha character(40);

ALTER TABLE external_source_snapshots
  ADD COLUMN origin_github_repository_id bigint,
  ADD COLUMN origin_owner text,
  ADD COLUMN origin_repository text;

ALTER TABLE external_source_snapshots DISABLE TRIGGER external_snapshots_immutable;
UPDATE external_source_snapshots snapshot
SET origin_github_repository_id=source.github_repository_id,
    origin_owner=COALESCE(
      (SELECT revision.canonical_bytes::jsonb #>> '{source,owner}'
       FROM external_skill_revisions revision
       WHERE revision.snapshot_id=snapshot.id ORDER BY revision.id LIMIT 1),
      source.owner
    ),
    origin_repository=COALESCE(
      (SELECT revision.canonical_bytes::jsonb #>> '{source,repository}'
       FROM external_skill_revisions revision
       WHERE revision.snapshot_id=snapshot.id ORDER BY revision.id LIMIT 1),
      source.repository
    )
FROM github_sources source
WHERE source.id=snapshot.source_id;
ALTER TABLE external_source_snapshots ENABLE TRIGGER external_snapshots_immutable;

ALTER TABLE external_source_snapshots
  ALTER COLUMN origin_github_repository_id SET NOT NULL,
  ALTER COLUMN origin_owner SET NOT NULL,
  ALTER COLUMN origin_repository SET NOT NULL,
  ADD CONSTRAINT external_snapshot_origin_repository_id_valid
    CHECK (origin_github_repository_id > 0),
  ADD CONSTRAINT external_snapshot_origin_owner_valid
    CHECK (length(origin_owner) BETWEEN 1 AND 100),
  ADD CONSTRAINT external_snapshot_origin_repository_valid
    CHECK (length(origin_repository) BETWEEN 1 AND 100);

ALTER TABLE external_skill_revisions DISABLE TRIGGER external_revisions_immutable;
UPDATE external_skill_revisions
SET origin_owner = canonical_bytes::jsonb #>> '{source,owner}',
    origin_repository = canonical_bytes::jsonb #>> '{source,repository}'
WHERE origin_owner IS NULL OR origin_repository IS NULL;
ALTER TABLE external_skill_revisions ENABLE TRIGGER external_revisions_immutable;

ALTER TABLE external_skill_revisions
  ALTER COLUMN origin_owner SET NOT NULL,
  ALTER COLUMN origin_repository SET NOT NULL,
  ADD CONSTRAINT external_revision_origin_owner_valid
    CHECK (length(origin_owner) BETWEEN 1 AND 100),
  ADD CONSTRAINT external_revision_origin_repository_valid
    CHECK (length(origin_repository) BETWEEN 1 AND 100),
  ADD CONSTRAINT external_revision_license_evidence_path_valid
    CHECK (license_evidence_path IS NULL OR length(license_evidence_path) BETWEEN 1 AND 512),
  ADD CONSTRAINT external_revision_license_blob_sha_valid
    CHECK (license_blob_sha IS NULL OR license_blob_sha ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT external_revision_skill_license_valid
    CHECK (skill_declared_spdx_id IS NULL OR length(skill_declared_spdx_id) BETWEEN 1 AND 64),
  ADD CONSTRAINT external_revision_notice_evidence_path_valid
    CHECK (notice_evidence_path IS NULL OR length(notice_evidence_path) BETWEEN 1 AND 512),
  ADD CONSTRAINT external_revision_notice_blob_sha_valid
    CHECK (notice_blob_sha IS NULL OR notice_blob_sha ~ '^[0-9a-f]{40}$');

ALTER TABLE github_sync_runs DROP CONSTRAINT github_sync_runs_state_check;
ALTER TABLE github_sync_runs ADD CONSTRAINT github_sync_runs_state_check CHECK (
  state IN ('queued', 'running', 'succeeded', 'published', 'quarantined', 'failed', 'cancelled', 'superseded')
);
ALTER TABLE github_sync_runs
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  ADD COLUMN queued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ADD COLUMN terminal_at timestamptz,
  ADD COLUMN requested_candidate_id uuid REFERENCES external_import_candidates(id) ON DELETE RESTRICT,
  ADD COLUMN requested_commit_sha character(40)
    CHECK (requested_commit_sha IS NULL OR requested_commit_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN requested_repository_id bigint CHECK (requested_repository_id IS NULL OR requested_repository_id > 0),
  ADD COLUMN requested_owner text CHECK (requested_owner IS NULL OR length(requested_owner) BETWEEN 1 AND 100),
  ADD COLUMN requested_repository text CHECK (requested_repository IS NULL OR length(requested_repository) BETWEEN 1 AND 100),
  ADD COLUMN previous_run_id uuid REFERENCES github_sync_runs(id) ON DELETE RESTRICT,
  ADD COLUMN summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT github_sync_runs_terminal_code_bounded
    CHECK (terminal_code IS NULL OR length(terminal_code) <= 80),
  ADD CONSTRAINT github_sync_runs_summary_object
    CHECK (jsonb_typeof(summary) = 'object' AND octet_length(summary::text) <= 4096);

CREATE INDEX github_sync_runs_claim_idx
  ON github_sync_runs (next_attempt_at, queued_at, id) WHERE state = 'queued';

ALTER TABLE external_import_candidates
  DROP CONSTRAINT external_import_candidates_snapshot_id_normalized_name_key;
CREATE INDEX external_candidates_snapshot_name_idx
  ON external_import_candidates (snapshot_id, normalized_name);

CREATE TABLE github_sync_candidate_results (
  id uuid PRIMARY KEY,
  sync_run_id uuid NOT NULL REFERENCES github_sync_runs(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 511),
  outcome text NOT NULL CHECK (outcome = 'quarantined'),
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  evidence_sha256 character(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (sync_run_id, ordinal)
);
CREATE TRIGGER github_sync_candidate_results_immutable
  BEFORE UPDATE OR DELETE ON github_sync_candidate_results
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
