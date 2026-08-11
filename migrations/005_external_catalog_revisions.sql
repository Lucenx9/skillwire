CREATE TABLE external_source_snapshots (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES github_sources(id) ON DELETE RESTRICT,
  commit_sha character(40) NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  tree_sha character(40) NOT NULL CHECK (tree_sha ~ '^[0-9a-f]{40}$'),
  manifest_version text NOT NULL CHECK (length(manifest_version) BETWEEN 1 AND 64),
  revision_count integer NOT NULL CHECK (revision_count BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (source_id, commit_sha)
);

ALTER TABLE github_sources
  ADD COLUMN current_published_snapshot_id uuid
  REFERENCES external_source_snapshots(id) ON DELETE RESTRICT;

CREATE TABLE external_content_objects (
  sha256 character(64) PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('instructions', 'resource', 'license')),
  media_type text NOT NULL CHECK (media_type IN ('text/markdown', 'text/plain')),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 262144),
  content text NOT NULL,
  CHECK (octet_length(content) = byte_length)
);

CREATE TABLE external_skill_identities (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES github_sources(id) ON DELETE RESTRICT,
  catalog_skill_id text NOT NULL UNIQUE
    CHECK (catalog_skill_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(catalog_skill_id) <= 80),
  normalized_skill_root text NOT NULL CHECK (
    length(normalized_skill_root) BETWEEN 1 AND 512
    AND normalized_skill_root !~ '(^/|\\|(^|/)\.\.?(/|$))'
  ),
  UNIQUE (source_id, normalized_skill_root)
);

CREATE TABLE external_skill_revisions (
  id uuid PRIMARY KEY,
  skill_identity_id uuid NOT NULL REFERENCES external_skill_identities(id) ON DELETE RESTRICT,
  snapshot_id uuid NOT NULL REFERENCES external_source_snapshots(id) ON DELETE RESTRICT,
  revision text NOT NULL CHECK (revision ~ '^gh-[0-9a-f]{64}$'),
  schema_version integer NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  trust_at_publication text NOT NULL DEFAULT 'structurally-verified'
    CHECK (trust_at_publication = 'structurally-verified'),
  bundle_sha256 character(64) NOT NULL CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  content_identity_sha256 character(64) NOT NULL CHECK (content_identity_sha256 ~ '^[0-9a-f]{64}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  skill_path text NOT NULL CHECK (
    length(skill_path) BETWEEN 1 AND 512
    AND skill_path ~ '^[^/\\]+(?:/[^/\\]+)*/SKILL\.md$'
    AND skill_path !~ '(^|/)\.\.?(/|$)'
  ),
  commit_sha character(40) NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  source_owner text NOT NULL CHECK (length(source_owner) BETWEEN 1 AND 200),
  spdx_license_id text NOT NULL CHECK (length(spdx_license_id) BETWEEN 1 AND 64),
  license_sha256 character(64) NOT NULL REFERENCES external_content_objects(sha256) ON DELETE RESTRICT,
  instructions_sha256 character(64) NOT NULL REFERENCES external_content_objects(sha256) ON DELETE RESTRICT,
  invocation_mode text NOT NULL CHECK (invocation_mode IN ('automatic', 'user-only')),
  canonical_bytes text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (skill_identity_id, content_identity_sha256),
  UNIQUE (skill_identity_id, revision),
  UNIQUE (bundle_sha256)
);

CREATE TABLE external_revision_resources (
  revision_id uuid NOT NULL REFERENCES external_skill_revisions(id) ON DELETE RESTRICT,
  resource_path text NOT NULL CHECK (
    length(resource_path) BETWEEN 1 AND 240
    AND resource_path !~ '(^/|\\|(^|/)\.\.?(/|$))'
  ),
  media_type text NOT NULL CHECK (media_type IN ('text/markdown', 'text/plain')),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 262144),
  content_sha256 character(64) NOT NULL REFERENCES external_content_objects(sha256) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
  PRIMARY KEY (revision_id, resource_path),
  UNIQUE (revision_id, ordinal)
);

CREATE TABLE external_revision_dependencies (
  revision_id uuid NOT NULL REFERENCES external_skill_revisions(id) ON DELETE RESTRICT,
  target_skill_name text NOT NULL CHECK (target_skill_name ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  required boolean NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('manifest', 'frontmatter', 'explicit-invocation')),
  evidence_locator text NOT NULL CHECK (length(evidence_locator) BETWEEN 1 AND 160),
  PRIMARY KEY (revision_id, target_skill_name)
);

CREATE TABLE external_snapshot_skill_observations (
  snapshot_id uuid NOT NULL REFERENCES external_source_snapshots(id) ON DELETE RESTRICT,
  skill_identity_id uuid NOT NULL REFERENCES external_skill_identities(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL REFERENCES external_skill_revisions(id) ON DELETE RESTRICT,
  result text NOT NULL CHECK (result IN ('published', 'reused')),
  PRIMARY KEY (snapshot_id, skill_identity_id)
);

CREATE FUNCTION reject_external_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'external catalog history is immutable';
END;
$$;

CREATE TRIGGER external_snapshots_immutable
  BEFORE UPDATE OR DELETE ON external_source_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER github_source_registrations_immutable
  BEFORE UPDATE OR DELETE ON github_source_registrations
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_content_immutable
  BEFORE UPDATE OR DELETE ON external_content_objects
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_identities_immutable
  BEFORE UPDATE OR DELETE ON external_skill_identities
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_revisions_immutable
  BEFORE UPDATE OR DELETE ON external_skill_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_resources_immutable
  BEFORE UPDATE OR DELETE ON external_revision_resources
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_dependencies_immutable
  BEFORE UPDATE OR DELETE ON external_revision_dependencies
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_observations_immutable
  BEFORE UPDATE OR DELETE ON external_snapshot_skill_observations
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();

CREATE INDEX external_snapshots_source_idx
  ON external_source_snapshots (source_id, created_at DESC);
CREATE INDEX external_revisions_snapshot_idx ON external_skill_revisions (snapshot_id);
CREATE INDEX external_observations_revision_idx ON external_snapshot_skill_observations (revision_id);
