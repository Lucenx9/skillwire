CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_id text NOT NULL UNIQUE
    CHECK (public_id ~ '^[A-Za-z0-9_-]{16}$'),
  secret_digest bytea NOT NULL
    CHECK (octet_length(secret_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at)
);

CREATE INDEX api_keys_account_id_idx ON api_keys (account_id, created_at);
