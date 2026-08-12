-- Finalize an immutable snapshot only after its publication advisories exist.

ALTER TABLE external_source_snapshots
  ALTER COLUMN advisory_chain_head_sha256 DROP NOT NULL;

DROP TRIGGER external_snapshots_immutable ON external_source_snapshots;

CREATE FUNCTION guard_external_snapshot_finalization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.advisory_chain_head_sha256 IS NULL
     AND NEW.advisory_chain_head_sha256 IS NOT NULL
     AND (to_jsonb(OLD) - 'advisory_chain_head_sha256') =
         (to_jsonb(NEW) - 'advisory_chain_head_sha256') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'external catalog history is immutable';
END;
$$;

CREATE TRIGGER external_snapshots_immutable
  BEFORE UPDATE OR DELETE ON external_source_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_external_snapshot_finalization();

CREATE FUNCTION require_external_snapshot_finalization() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  final_head character(64);
BEGIN
  SELECT advisory_chain_head_sha256 INTO final_head
  FROM external_source_snapshots WHERE id = NEW.id;
  IF final_head IS NULL THEN
    RAISE EXCEPTION 'external snapshot advisory head is not finalized';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER external_snapshot_finalization_required
  AFTER INSERT OR UPDATE ON external_source_snapshots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_external_snapshot_finalization();
