CREATE TABLE github_sources (
  id uuid PRIMARY KEY,
  github_repository_id bigint NOT NULL UNIQUE CHECK (github_repository_id > 0),
  source_type text NOT NULL DEFAULT 'github-public' CHECK (source_type = 'github-public'),
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility = 'public'),
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 100),
  repository text NOT NULL CHECK (length(repository) BETWEEN 1 AND 100),
  normalized_owner text NOT NULL CHECK (normalized_owner = lower(normalized_owner)),
  normalized_repository text NOT NULL CHECK (normalized_repository = lower(normalized_repository)),
  default_branch text NOT NULL CHECK (length(default_branch) BETWEEN 1 AND 255),
  first_observed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_observed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (normalized_owner, normalized_repository)
);

CREATE TABLE github_source_registrations (
  source_id uuid PRIMARY KEY REFERENCES github_sources(id) ON DELETE RESTRICT,
  registered_by text NOT NULL CHECK (length(registered_by) BETWEEN 1 AND 160),
  registered_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  synchronization_enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE github_source_aliases (
  normalized_owner text NOT NULL CHECK (normalized_owner = lower(normalized_owner)),
  normalized_repository text NOT NULL CHECK (normalized_repository = lower(normalized_repository)),
  source_id uuid NOT NULL REFERENCES github_sources(id) ON DELETE RESTRICT,
  first_observed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_observed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  alias_reason text NOT NULL DEFAULT 'registration'
    CHECK (alias_reason IN ('registration', 'canonical', 'rename')),
  PRIMARY KEY (normalized_owner, normalized_repository)
);

CREATE TABLE github_sync_runs (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES github_sources(id) ON DELETE RESTRICT,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('registration', 'administrator')),
  state text NOT NULL CHECK (
    state IN ('queued', 'running', 'published', 'quarantined', 'failed', 'cancelled', 'superseded')
  ),
  commit_sha character(40) CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}$'),
  trace_count integer NOT NULL DEFAULT 0 CHECK (trace_count >= 0),
  terminal_code text,
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  completed_at timestamptz,
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE UNIQUE INDEX github_sync_runs_one_running_idx
  ON github_sync_runs (source_id) WHERE state = 'running';
CREATE INDEX github_sources_coordinates_idx
  ON github_sources (normalized_owner, normalized_repository);
CREATE INDEX github_sync_runs_source_idx
  ON github_sync_runs (source_id, started_at DESC);
