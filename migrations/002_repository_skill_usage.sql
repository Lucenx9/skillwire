CREATE TABLE repository_skill_usage (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  repository_hash character(64) NOT NULL
    CHECK (repository_hash ~ '^[0-9a-f]{64}$'),
  skill_id text NOT NULL
    CHECK (skill_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(skill_id) <= 80),
  revision text NOT NULL
    CHECK (revision ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND length(revision) <= 128),
  bundle_sha256 character(64) NOT NULL
    CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  first_used_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_used_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  usage_count integer NOT NULL DEFAULT 1
    CHECK (usage_count > 0),
  outcome text
    CHECK (outcome IS NULL OR outcome IN ('useful', 'neutral', 'unsuccessful')),
  PRIMARY KEY (account_id, repository_hash, skill_id, revision),
  CHECK (last_used_at >= first_used_at)
);

CREATE INDEX repository_skill_usage_scope_idx
  ON repository_skill_usage (
    account_id,
    repository_hash,
    last_used_at DESC,
    skill_id,
    revision
  );
