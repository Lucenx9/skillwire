ALTER TABLE github_source_registrations
  ADD COLUMN synchronization_interval_seconds integer NOT NULL DEFAULT 3600
    CHECK (synchronization_interval_seconds BETWEEN 60 AND 604800),
  ADD COLUMN next_sync_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ADD COLUMN last_terminal_run_id uuid;

DROP TRIGGER github_source_registrations_immutable ON github_source_registrations;
CREATE FUNCTION protect_github_registration_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW.source_id <> OLD.source_id
     OR NEW.registered_by <> OLD.registered_by
     OR NEW.registered_at <> OLD.registered_at THEN
    RAISE EXCEPTION 'github source registration identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER github_source_registration_identity_immutable
  BEFORE UPDATE OR DELETE ON github_source_registrations
  FOR EACH ROW EXECUTE FUNCTION protect_github_registration_identity();

ALTER TABLE github_sources
  ADD COLUMN source_classification text NOT NULL DEFAULT 'discovered'
    CHECK (source_classification IN ('discovered', 'verified', 'quarantined', 'curated')),
  ADD COLUMN metadata_etag text CHECK (metadata_etag IS NULL OR length(metadata_etag) <= 512),
  ADD COLUMN metadata_cache_sha256 character(64)
    CHECK (metadata_cache_sha256 IS NULL OR metadata_cache_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN unavailable_confirmation_count integer NOT NULL DEFAULT 0
    CHECK (unavailable_confirmation_count BETWEEN 0 AND 4),
  ADD COLUMN unavailable_first_observed_at timestamptz,
  ADD COLUMN unavailable_last_observed_at timestamptz;

ALTER TABLE github_sync_runs DROP CONSTRAINT github_sync_runs_trigger_kind_check;
ALTER TABLE github_sync_runs ADD CONSTRAINT github_sync_runs_trigger_kind_check
  CHECK (trigger_kind IN ('registration', 'administrator', 'scheduled', 'discovery'));
ALTER TABLE github_sync_runs
  ADD COLUMN tree_sha character(40) CHECK (tree_sha IS NULL OR tree_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN holder_id uuid,
  ADD COLUMN fencing_token bigint CHECK (fencing_token IS NULL OR fencing_token > 0),
  ADD COLUMN retryable boolean NOT NULL DEFAULT false,
  ADD COLUMN request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  ADD COLUMN candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  ADD COLUMN resource_count integer NOT NULL DEFAULT 0 CHECK (resource_count >= 0),
  ADD COLUMN decoded_bytes bigint NOT NULL DEFAULT 0 CHECK (decoded_bytes >= 0),
  ADD COLUMN heartbeat_at timestamptz;

DROP INDEX github_sync_runs_one_running_idx;
CREATE UNIQUE INDEX github_sync_runs_one_active_idx
  ON github_sync_runs (source_id) WHERE state IN ('queued', 'running');

CREATE TABLE github_discovery_runs (
  id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  query_set_sha256 character(64) NOT NULL CHECK (query_set_sha256 ~ '^[0-9a-f]{64}$'),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
  maximum_queries integer NOT NULL CHECK (maximum_queries BETWEEN 1 AND 16),
  maximum_pages integer NOT NULL CHECK (maximum_pages BETWEEN 1 AND 160),
  maximum_results integer NOT NULL CHECK (maximum_results BETWEEN 1 AND 4000),
  maximum_requests integer NOT NULL CHECK (maximum_requests BETWEEN 1 AND 2000),
  maximum_response_bytes bigint NOT NULL CHECK (maximum_response_bytes > 0),
  query_count integer NOT NULL DEFAULT 0 CHECK (query_count >= 0),
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  unique_source_count integer NOT NULL DEFAULT 0 CHECK (unique_source_count >= 0),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  response_bytes bigint NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
  holder_id uuid,
  fencing_token bigint CHECK (fencing_token IS NULL OR fencing_token > 0),
  terminal_code text CHECK (terminal_code IS NULL OR length(terminal_code) <= 80),
  queued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE UNIQUE INDEX github_discovery_runs_one_active_idx
  ON github_discovery_runs ((true)) WHERE state IN ('queued', 'running');

CREATE TABLE github_discovery_evidence (
  id uuid PRIMARY KEY,
  discovery_run_id uuid NOT NULL REFERENCES github_discovery_runs(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES github_sources(id) ON DELETE RESTRICT,
  evidence_kind text NOT NULL
    CHECK (evidence_kind IN ('claude-plugin-manifest', 'nested-skill-document')),
  normalized_path_sha256 character(64) NOT NULL
    CHECK (normalized_path_sha256 ~ '^[0-9a-f]{64}$'),
  safe_basename text NOT NULL CHECK (safe_basename IN ('plugin.json', 'SKILL.md')),
  observed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (discovery_run_id, source_id, evidence_kind, normalized_path_sha256)
);

CREATE TABLE github_metadata_cache (
  cache_key_sha256 character(64) PRIMARY KEY CHECK (cache_key_sha256 ~ '^[0-9a-f]{64}$'),
  etag text NOT NULL CHECK (length(etag) BETWEEN 1 AND 512),
  body_sha256 character(64) NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  validated_body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE github_job_leases (
  lease_key text PRIMARY KEY CHECK (lease_key = 'discovery' OR lease_key ~ '^sync/[0-9a-f-]{36}$'),
  holder_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  acquired_at timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  CHECK (lease_expires_at > renewed_at)
);
CREATE INDEX github_job_leases_expiry_idx ON github_job_leases (lease_expires_at);

ALTER TABLE external_source_snapshots DROP CONSTRAINT external_source_snapshots_revision_count_check;
ALTER TABLE external_source_snapshots
  ADD CONSTRAINT external_source_snapshots_revision_count_check
    CHECK (revision_count BETWEEN 0 AND 256),
  ADD COLUMN adapter_kind text NOT NULL DEFAULT 'claude-plugin'
    CHECK (adapter_kind IN ('claude-plugin', 'nested-skill')),
  ADD COLUMN candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count BETWEEN 0 AND 512),
  ADD COLUMN quarantine_count integer NOT NULL DEFAULT 0 CHECK (quarantine_count BETWEEN 0 AND 512),
  ADD COLUMN resource_count integer NOT NULL DEFAULT 0 CHECK (resource_count >= 0),
  ADD COLUMN dependency_count integer NOT NULL DEFAULT 0 CHECK (dependency_count >= 0),
  ADD COLUMN decoded_bytes bigint NOT NULL DEFAULT 0 CHECK (decoded_bytes >= 0),
  ADD COLUMN validation_input_sha256 character(64)
    CHECK (validation_input_sha256 IS NULL OR validation_input_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN advisory_chain_head_sha256 character(64) NOT NULL DEFAULT repeat('0', 64)
    CHECK (advisory_chain_head_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE external_content_objects DROP CONSTRAINT external_content_objects_kind_check;
ALTER TABLE external_content_objects ADD CONSTRAINT external_content_objects_kind_check
  CHECK (kind IN ('instructions', 'resource', 'license', 'notice'));

ALTER TABLE external_skill_revisions DROP CONSTRAINT external_skill_revisions_skill_path_check;
ALTER TABLE external_skill_revisions ADD CONSTRAINT external_skill_revisions_skill_path_check
  CHECK (
    length(skill_path) BETWEEN 1 AND 512
    AND (skill_path = 'SKILL.md' OR skill_path ~ '^[^/\\]+(?:/[^/\\]+)*/SKILL\.md$')
    AND skill_path !~ '(^|/)\.\.?(/|$)'
  );

ALTER TABLE external_revision_dependencies
  ADD COLUMN target_skill_identity_id uuid REFERENCES external_skill_identities(id) ON DELETE RESTRICT,
  ADD COLUMN target_revision_id uuid REFERENCES external_skill_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN evidence_source_sha256 character(64)
    CHECK (evidence_source_sha256 IS NULL OR evidence_source_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE external_revision_dependencies DISABLE TRIGGER external_dependencies_immutable;
UPDATE external_revision_dependencies d SET
  target_skill_identity_id = target.skill_identity_id,
  target_revision_id = target.id,
  evidence_source_sha256 = source.instructions_sha256
FROM external_skill_revisions source
JOIN external_skill_revisions target
  ON target.snapshot_id = source.snapshot_id
WHERE source.id = d.revision_id AND target.name = d.target_skill_name;
ALTER TABLE external_revision_dependencies ENABLE TRIGGER external_dependencies_immutable;
ALTER TABLE external_revision_dependencies
  ALTER COLUMN target_skill_identity_id SET NOT NULL,
  ALTER COLUMN target_revision_id SET NOT NULL,
  ALTER COLUMN evidence_source_sha256 SET NOT NULL;

CREATE TABLE external_import_candidates (
  id uuid PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES external_source_snapshots(id) ON DELETE RESTRICT,
  skill_identity_id uuid REFERENCES external_skill_identities(id) ON DELETE RESTRICT,
  published_revision_id uuid REFERENCES external_skill_revisions(id) ON DELETE RESTRICT,
  adapter_kind text NOT NULL CHECK (adapter_kind IN ('claude-plugin', 'nested-skill')),
  normalized_skill_root text NOT NULL CHECK (
    length(normalized_skill_root) BETWEEN 1 AND 512
    AND normalized_skill_root !~ '(^/|\\|(^|/)\.\.?(/|$))'
  ),
  normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 120),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  skill_document_path text NOT NULL CHECK (
    length(skill_document_path) BETWEEN 1 AND 512
    AND (skill_document_path = 'SKILL.md' OR skill_document_path ~ '^[^/\\]+(?:/[^/\\]+)*/SKILL\.md$')
    AND skill_document_path !~ '(^|/)\.\.?(/|$)'
  ),
  source_path_sha256 character(64) NOT NULL CHECK (source_path_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (snapshot_id, normalized_skill_root),
  UNIQUE (snapshot_id, normalized_name)
);

CREATE TABLE external_verification_reports (
  id uuid PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES external_import_candidates(id) ON DELETE RESTRICT,
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
  validator_version text NOT NULL CHECK (length(validator_version) BETWEEN 1 AND 64),
  input_sha256 character(64) NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  report_sha256 character(64) NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  result text NOT NULL CHECK (result IN ('passed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (candidate_id, policy_version, validator_version, input_sha256)
);

CREATE TABLE external_validation_findings (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES external_verification_reports(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 255),
  reason_code text NOT NULL CHECK (reason_code IN (
    'MANIFEST_INVALID', 'MANIFEST_DUPLICATE_SKILL', 'SKILL_SCHEMA_INVALID',
    'SKILL_DUPLICATE_IDENTITY', 'COMMIT_MISMATCH', 'TREE_TRUNCATED', 'TREE_OVERSIZED',
    'TREE_AMBIGUOUS', 'OBJECT_UNSUPPORTED', 'PATH_UNSAFE', 'RESOURCE_MISSING',
    'RESOURCE_NON_TEXT', 'RESOURCE_OVERSIZED', 'LICENSE_MISSING', 'LICENSE_UNSUPPORTED',
    'LICENSE_CONFLICT', 'ATTRIBUTION_MISSING', 'DEPENDENCY_MISSING',
    'DEPENDENCY_AMBIGUOUS', 'DEPENDENCY_CYCLE', 'HASH_MISMATCH', 'PUBLICATION_CONFLICT',
    'ADMIN_QUARANTINE'
  )),
  severity text NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
  subject_kind text NOT NULL CHECK (subject_kind IN ('source', 'snapshot', 'candidate', 'revision', 'resource')),
  subject_locator_sha256 character(64) NOT NULL CHECK (subject_locator_sha256 ~ '^[0-9a-f]{64}$'),
  safe_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (report_id, ordinal)
);

CREATE TABLE external_classification_events (
  id uuid PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES external_import_candidates(id) ON DELETE RESTRICT,
  previous_classification text CHECK (
    previous_classification IS NULL OR previous_classification IN ('discovered', 'verified', 'quarantined', 'curated')
  ),
  next_classification text NOT NULL CHECK (next_classification IN ('discovered', 'verified', 'quarantined', 'curated')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('discovery', 'verifier', 'administrator', 'synchronization')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 160),
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  report_id uuid REFERENCES external_verification_reports(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE external_current_classifications (
  candidate_id uuid PRIMARY KEY REFERENCES external_import_candidates(id) ON DELETE RESTRICT,
  classification text NOT NULL CHECK (classification IN ('discovered', 'verified', 'quarantined', 'curated')),
  latest_event_id uuid NOT NULL UNIQUE REFERENCES external_classification_events(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE external_current_revision_classifications (
  revision_id uuid PRIMARY KEY REFERENCES external_skill_revisions(id) ON DELETE RESTRICT,
  classification text NOT NULL CHECK (classification IN ('verified', 'quarantined', 'curated')),
  latest_event_id uuid NOT NULL REFERENCES external_classification_events(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE FUNCTION validate_external_classification_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    (NEW.previous_classification IS NULL AND NEW.next_classification = 'discovered'
      AND NEW.actor_kind IN ('discovery', 'synchronization'))
    OR (NEW.previous_classification = 'discovered' AND NEW.next_classification IN ('verified', 'quarantined')
      AND NEW.actor_kind = 'verifier')
    OR (NEW.previous_classification = 'quarantined' AND NEW.next_classification = 'verified'
      AND NEW.actor_kind = 'verifier')
    OR (NEW.previous_classification = 'verified' AND NEW.next_classification = 'curated'
      AND NEW.actor_kind = 'administrator')
    OR (NEW.previous_classification IN ('verified', 'curated') AND NEW.next_classification = 'quarantined'
      AND NEW.actor_kind = 'administrator')
  ) THEN
    RAISE EXCEPTION 'invalid external classification transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_classification_transition_valid
  BEFORE INSERT ON external_classification_events
  FOR EACH ROW EXECUTE FUNCTION validate_external_classification_transition();

CREATE TABLE external_curation_decisions (
  id uuid PRIMARY KEY,
  classification_event_id uuid NOT NULL UNIQUE REFERENCES external_classification_events(id) ON DELETE RESTRICT,
  administrator_id text NOT NULL CHECK (length(administrator_id) BETWEEN 1 AND 160),
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  rationale_sha256 character(64) CHECK (rationale_sha256 IS NULL OR rationale_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

ALTER TABLE external_snapshot_skill_observations
  ALTER COLUMN revision_id DROP NOT NULL;
ALTER TABLE external_snapshot_skill_observations DROP CONSTRAINT external_snapshot_skill_observations_result_check;
ALTER TABLE external_snapshot_skill_observations ADD CONSTRAINT external_snapshot_skill_observations_result_check
  CHECK (result IN ('published', 'reused', 'quarantined', 'missing'));
ALTER TABLE external_snapshot_skill_observations
  ADD COLUMN candidate_id uuid REFERENCES external_import_candidates(id) ON DELETE RESTRICT,
  ADD COLUMN observed_content_identity_sha256 character(64)
    CHECK (observed_content_identity_sha256 IS NULL OR observed_content_identity_sha256 ~ '^[0-9a-f]{64}$');

-- Backfill Slice 1 publications with derived policy rows so an upgraded database
-- remains immediately verifiable and idempotent. Immutable content/provenance is not rewritten.
INSERT INTO external_import_candidates (
  id,snapshot_id,skill_identity_id,published_revision_id,adapter_kind,
  normalized_skill_root,normalized_name,display_name,description,
  skill_document_path,source_path_sha256
)
SELECT
  md5(o.snapshot_id::text || ':' || o.skill_identity_id::text)::uuid,
  o.snapshot_id,o.skill_identity_id,o.revision_id,'claude-plugin',
  CASE WHEN r.skill_path='SKILL.md' THEN '_root'
       ELSE regexp_replace(r.skill_path,'/SKILL\.md$','') END,
  lower(r.name),r.name,r.description,r.skill_path,
  encode(sha256(convert_to(r.skill_path,'UTF8')),'hex')
FROM external_snapshot_skill_observations o
JOIN external_skill_revisions r ON r.id=o.revision_id
ON CONFLICT DO NOTHING;

INSERT INTO external_verification_reports (
  id,candidate_id,policy_version,validator_version,input_sha256,report_sha256,result
)
SELECT
  md5(c.id::text || ':report')::uuid,c.id,'external-policy-v1','external-validator-v1',
  r.content_identity_sha256,r.bundle_sha256,'passed'
FROM external_import_candidates c
JOIN external_skill_revisions r ON r.id=c.published_revision_id
ON CONFLICT DO NOTHING;

INSERT INTO external_classification_events (
  id,candidate_id,previous_classification,next_classification,
  actor_kind,actor_id,reason_code,report_id
)
SELECT md5(c.id::text || ':discovered')::uuid,c.id,NULL,'discovered',
       'synchronization','migration-006','CANDIDATE_DISCOVERED',NULL
FROM external_import_candidates c
ON CONFLICT DO NOTHING;

INSERT INTO external_classification_events (
  id,candidate_id,previous_classification,next_classification,
  actor_kind,actor_id,reason_code,report_id
)
SELECT md5(c.id::text || ':verified')::uuid,c.id,'discovered','verified',
       'verifier','migration-006','AUTOMATIC_VERIFICATION_PASSED',vr.id
FROM external_import_candidates c
JOIN external_verification_reports vr ON vr.candidate_id=c.id
ON CONFLICT DO NOTHING;

INSERT INTO external_current_classifications (
  candidate_id,classification,latest_event_id
)
SELECT c.id,'verified',md5(c.id::text || ':verified')::uuid
FROM external_import_candidates c
ON CONFLICT DO NOTHING;

ALTER TABLE external_snapshot_skill_observations DISABLE TRIGGER external_observations_immutable;
UPDATE external_snapshot_skill_observations o SET
  candidate_id=md5(o.snapshot_id::text || ':' || o.skill_identity_id::text)::uuid,
  observed_content_identity_sha256=r.content_identity_sha256
FROM external_skill_revisions r
WHERE r.id=o.revision_id AND o.candidate_id IS NULL;
ALTER TABLE external_snapshot_skill_observations ENABLE TRIGGER external_observations_immutable;

INSERT INTO external_current_revision_classifications (
  revision_id,classification,latest_event_id
)
SELECT DISTINCT o.revision_id,'verified',md5(c.id::text || ':verified')::uuid
FROM external_snapshot_skill_observations o
JOIN external_import_candidates c ON c.id=o.candidate_id
WHERE o.revision_id IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE external_source_snapshots DISABLE TRIGGER external_snapshots_immutable;
UPDATE external_source_snapshots s SET
  candidate_count=(SELECT count(*) FROM external_import_candidates c WHERE c.snapshot_id=s.id),
  resource_count=(SELECT count(*) FROM external_revision_resources rr
                  JOIN external_skill_revisions r ON r.id=rr.revision_id WHERE r.snapshot_id=s.id),
  dependency_count=(SELECT count(*) FROM external_revision_dependencies d
                    JOIN external_skill_revisions r ON r.id=d.revision_id WHERE r.snapshot_id=s.id),
  decoded_bytes=(SELECT COALESCE(sum(octet_length(r.canonical_bytes)),0)
                 FROM external_skill_revisions r WHERE r.snapshot_id=s.id);
ALTER TABLE external_source_snapshots ENABLE TRIGGER external_snapshots_immutable;

CREATE TABLE external_advisory_chain_head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
  last_event_sha256 character(64) NOT NULL CHECK (last_event_sha256 ~ '^[0-9a-f]{64}$')
);
INSERT INTO external_advisory_chain_head (singleton, last_sequence, last_event_sha256)
VALUES (true, 0, repeat('0', 64));

CREATE TABLE external_revision_advisory_events (
  id uuid PRIMARY KEY,
  sequence bigint NOT NULL UNIQUE CHECK (sequence > 0),
  previous_event_sha256 character(64) NOT NULL CHECK (previous_event_sha256 ~ '^[0-9a-f]{64}$'),
  event_sha256 character(64) NOT NULL UNIQUE CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
  revision_id uuid NOT NULL REFERENCES external_skill_revisions(id) ON DELETE RESTRICT,
  advisory_kind text NOT NULL CHECK (advisory_kind IN ('availability', 'security')),
  advisory_status text NOT NULL CHECK (advisory_status IN ('available', 'unavailable', 'revoked')),
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE FUNCTION validate_external_advisory_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head_sequence bigint;
  head_hash character(64);
BEGIN
  SELECT last_sequence, last_event_sha256 INTO head_sequence, head_hash
  FROM external_advisory_chain_head WHERE singleton FOR UPDATE;
  IF NEW.sequence <> head_sequence + 1 OR NEW.previous_event_sha256 <> head_hash THEN
    RAISE EXCEPTION 'invalid external advisory append';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_advisory_append_valid
  BEFORE INSERT ON external_revision_advisory_events
  FOR EACH ROW EXECUTE FUNCTION validate_external_advisory_append();

CREATE TRIGGER external_candidates_immutable
  BEFORE UPDATE OR DELETE ON external_import_candidates
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_reports_immutable
  BEFORE UPDATE OR DELETE ON external_verification_reports
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_findings_immutable
  BEFORE UPDATE OR DELETE ON external_validation_findings
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_classification_events_immutable
  BEFORE UPDATE OR DELETE ON external_classification_events
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_curation_decisions_immutable
  BEFORE UPDATE OR DELETE ON external_curation_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_advisory_events_immutable
  BEFORE UPDATE OR DELETE ON external_revision_advisory_events
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();

CREATE INDEX github_registrations_due_idx
  ON github_source_registrations (next_sync_at) WHERE synchronization_enabled;
CREATE INDEX github_discovery_evidence_source_idx ON github_discovery_evidence (source_id, observed_at DESC);
CREATE INDEX external_candidates_snapshot_idx ON external_import_candidates (snapshot_id);
CREATE INDEX external_findings_report_idx ON external_validation_findings (report_id, ordinal);
CREATE INDEX external_classification_events_candidate_idx
  ON external_classification_events (candidate_id, created_at DESC);
CREATE INDEX external_advisories_revision_idx
  ON external_revision_advisory_events (revision_id, sequence DESC);
