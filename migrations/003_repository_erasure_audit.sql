CREATE TABLE repository_erasure_audit (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  request_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  operation_result text NOT NULL
    CHECK (operation_result = 'forgotten'),
  removed_record_count integer NOT NULL
    CHECK (removed_record_count >= 0),
  CHECK (expires_at = created_at + interval '30 days')
);

CREATE INDEX repository_erasure_audit_expiry_idx
  ON repository_erasure_audit (expires_at);

CREATE INDEX repository_erasure_audit_account_idx
  ON repository_erasure_audit (account_id, created_at DESC);
