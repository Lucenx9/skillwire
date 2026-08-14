ALTER TABLE external_source_snapshots
  DROP CONSTRAINT external_source_snapshots_source_id_commit_sha_key;

ALTER TABLE external_source_snapshots
  ADD CONSTRAINT external_source_snapshots_validation_generation_unique
  UNIQUE NULLS NOT DISTINCT (source_id, commit_sha, validation_input_sha256);
