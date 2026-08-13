-- Separate raw candidate-observation history from shared revision eligibility history.

-- Maintenance migration lock order matches runtime classification ordering:
-- candidate projection, candidate events, candidate curation decisions, then
-- shared revision projection.
-- The runner's bounded lock_timeout turns a forgotten writer into a clean
-- transaction failure instead of waiting indefinitely.
LOCK TABLE external_current_classifications IN ACCESS EXCLUSIVE MODE;
LOCK TABLE external_classification_events IN ACCESS EXCLUSIVE MODE;
LOCK TABLE external_curation_decisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE external_current_revision_classifications IN ACCESS EXCLUSIVE MODE;

COMMENT ON TABLE external_classification_events IS
  'Append-only raw per-observation candidate classification events; candidate_id is the sole subject.';

CREATE OR REPLACE FUNCTION validate_external_classification_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_classification text;
BEGIN
  IF NOT (
    (NEW.previous_classification IS NULL AND NEW.next_classification = 'discovered'
      AND NEW.actor_kind IN ('discovery', 'synchronization') AND NEW.report_id IS NULL)
    OR (NEW.previous_classification = 'discovered' AND NEW.next_classification IN ('verified', 'quarantined')
      AND NEW.actor_kind = 'verifier' AND NEW.report_id IS NOT NULL)
    OR (NEW.previous_classification = 'quarantined' AND NEW.next_classification = 'verified'
      AND NEW.actor_kind = 'verifier' AND NEW.report_id IS NOT NULL)
    OR (NEW.previous_classification = 'verified' AND NEW.next_classification = 'curated'
      AND NEW.actor_kind = 'administrator' AND NEW.report_id IS NULL)
    OR (NEW.previous_classification IN ('verified', 'curated') AND NEW.next_classification = 'quarantined'
      AND NEW.actor_kind = 'administrator' AND NEW.report_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'invalid external candidate classification transition';
  END IF;

  IF NEW.report_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM external_verification_reports report
    WHERE report.id=NEW.report_id AND report.candidate_id=NEW.candidate_id
  ) THEN
    RAISE EXCEPTION 'external candidate classification report subject mismatch';
  END IF;
  IF NEW.next_classification = 'verified' AND NOT EXISTS (
    SELECT 1 FROM external_verification_reports report
    WHERE report.id=NEW.report_id
      AND report.candidate_id=NEW.candidate_id
      AND report.result='passed'
  ) THEN
    RAISE EXCEPTION 'external candidate verification transition requires a passed verification report';
  END IF;
  SELECT classification INTO current_classification
  FROM external_current_classifications
  WHERE candidate_id=NEW.candidate_id
  FOR UPDATE;
  IF NEW.previous_classification IS NULL THEN
    IF current_classification IS NOT NULL THEN
      RAISE EXCEPTION 'external candidate classification history is discontinuous';
    END IF;
  ELSIF current_classification IS DISTINCT FROM NEW.previous_classification THEN
    RAISE EXCEPTION 'external candidate classification history is discontinuous';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE external_revision_classification_events (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES external_skill_revisions(id) ON DELETE RESTRICT,
  initiating_candidate_id uuid NOT NULL REFERENCES external_import_candidates(id) ON DELETE RESTRICT,
  previous_classification text CHECK (
    previous_classification IS NULL OR previous_classification IN ('verified', 'quarantined', 'curated')
  ),
  next_classification text NOT NULL CHECK (next_classification IN ('verified', 'quarantined', 'curated')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('verifier', 'administrator', 'synchronization')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 160),
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  report_id uuid REFERENCES external_verification_reports(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (revision_id, id, next_classification)
);

COMMENT ON TABLE external_revision_classification_events IS
  'Append-only shared revision eligibility events; revision_id is the sole subject and initiating_candidate_id records attribution only.';
COMMENT ON COLUMN external_revision_classification_events.initiating_candidate_id IS
  'Attribution only, never event ownership. A migration-010 baseline uses the candidate from the legacy current projection event and does not claim a historical transition initiator.';

CREATE FUNCTION validate_external_revision_classification_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_classification text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM external_snapshot_skill_observations observation
    WHERE observation.candidate_id=NEW.initiating_candidate_id
      AND observation.revision_id=NEW.revision_id
  ) THEN
    RAISE EXCEPTION 'external revision classification candidate attribution mismatch';
  END IF;

  IF NEW.report_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM external_verification_reports report
    WHERE report.id=NEW.report_id
      AND report.candidate_id=NEW.initiating_candidate_id
  ) THEN
    RAISE EXCEPTION 'external revision classification report attribution mismatch';
  END IF;
  IF NEW.next_classification = 'verified' AND NEW.actor_kind = 'verifier'
     AND NOT EXISTS (
       SELECT 1 FROM external_verification_reports report
       WHERE report.id=NEW.report_id
         AND report.candidate_id=NEW.initiating_candidate_id
         AND report.result='passed'
     ) THEN
    RAISE EXCEPTION 'external revision verification transition requires a passed verification report';
  END IF;
  IF NOT (
    (NEW.previous_classification IS NULL AND NEW.next_classification = 'verified'
      AND NEW.actor_kind = 'verifier' AND NEW.report_id IS NOT NULL)
    OR (NEW.previous_classification IS NULL
      AND NEW.actor_kind = 'synchronization'
      AND NEW.actor_id = 'migration-010'
      AND NEW.reason_code = 'REVISION_CLASSIFICATION_BACKFILLED'
      AND NEW.report_id IS NULL)
    OR (NEW.previous_classification = 'quarantined' AND NEW.next_classification = 'verified'
      AND NEW.actor_kind = 'verifier' AND NEW.report_id IS NOT NULL)
    OR (NEW.previous_classification = 'verified' AND NEW.next_classification = 'curated'
      AND NEW.actor_kind = 'administrator' AND NEW.report_id IS NULL)
    OR (NEW.previous_classification IN ('verified', 'curated') AND NEW.next_classification = 'quarantined'
      AND NEW.actor_kind = 'administrator' AND NEW.report_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'invalid external revision classification transition';
  END IF;

  SELECT classification INTO current_classification
  FROM external_current_revision_classifications
  WHERE revision_id=NEW.revision_id
  FOR UPDATE;
  IF NEW.actor_kind = 'synchronization' AND NEW.actor_id = 'migration-010' THEN
    IF NEW.id IS DISTINCT FROM
         md5(NEW.revision_id::text || ':revision-classification-backfill-010')::uuid
       OR current_classification IS DISTINCT FROM NEW.next_classification
       OR EXISTS (
         SELECT 1 FROM external_revision_classification_events event
         WHERE event.revision_id=NEW.revision_id
       ) THEN
      RAISE EXCEPTION 'external revision classification backfill mismatch';
    END IF;
  ELSIF NEW.previous_classification IS NULL THEN
    IF current_classification IS NOT NULL THEN
      RAISE EXCEPTION 'external revision classification history is discontinuous';
    END IF;
  ELSIF current_classification IS DISTINCT FROM NEW.previous_classification THEN
    RAISE EXCEPTION 'external revision classification history is discontinuous';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_revision_classification_transition_valid
  BEFORE INSERT ON external_revision_classification_events
  FOR EACH ROW EXECUTE FUNCTION validate_external_revision_classification_transition();
CREATE TRIGGER external_revision_classification_events_immutable
  BEFORE UPDATE OR DELETE ON external_revision_classification_events
  FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE INDEX external_revision_classification_events_revision_idx
  ON external_revision_classification_events (revision_id, created_at DESC, id);

-- Migration 010 cannot reconstruct a complete revision-only event chain from the
-- formerly overloaded candidate events. Preserve those immutable candidate rows
-- unchanged and establish one explicit revision baseline at the existing current
-- classification. The event creation timestamp is the migration transaction
-- timestamp; the prior projection timestamp is not an event timestamp. All
-- events after this baseline are fully typed.
INSERT INTO external_revision_classification_events (
  id,revision_id,initiating_candidate_id,previous_classification,
  next_classification,actor_kind,actor_id,reason_code,report_id,created_at
)
SELECT
  md5(current.revision_id::text || ':revision-classification-backfill-010')::uuid,
  current.revision_id,event.candidate_id,NULL,current.classification,
  'synchronization','migration-010','REVISION_CLASSIFICATION_BACKFILLED',NULL,
  transaction_timestamp()
FROM external_current_revision_classifications current
JOIN external_classification_events event ON event.id=current.latest_event_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM external_current_revision_classifications current
    LEFT JOIN external_revision_classification_events event
      ON event.revision_id=current.revision_id
     AND event.next_classification=current.classification
    WHERE event.id IS NULL
  ) THEN
    RAISE EXCEPTION 'external revision classification backfill incomplete';
  END IF;
END;
$$;

ALTER TABLE external_classification_events
  ADD CONSTRAINT external_candidate_classification_event_subject_unique
  UNIQUE (candidate_id, id, next_classification);
ALTER TABLE external_current_classifications
  ADD CONSTRAINT external_current_candidate_event_subject_valid
  FOREIGN KEY (candidate_id, latest_event_id, classification)
  REFERENCES external_classification_events (candidate_id, id, next_classification)
  ON DELETE RESTRICT;

ALTER TABLE external_current_revision_classifications
  DROP CONSTRAINT external_current_revision_classifications_latest_event_id_fkey;
UPDATE external_current_revision_classifications current SET
  latest_event_id=md5(current.revision_id::text || ':revision-classification-backfill-010')::uuid;
ALTER TABLE external_current_revision_classifications
  ADD CONSTRAINT external_current_revision_event_subject_valid
  FOREIGN KEY (revision_id, latest_event_id, classification)
  REFERENCES external_revision_classification_events (revision_id, id, next_classification)
  ON DELETE RESTRICT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM external_current_revision_classifications current
    LEFT JOIN external_revision_classification_events event
      ON event.id=current.latest_event_id
     AND event.revision_id=current.revision_id
     AND event.next_classification=current.classification
     AND event.previous_classification IS NULL
     AND event.actor_kind='synchronization'
     AND event.actor_id='migration-010'
     AND event.reason_code='REVISION_CLASSIFICATION_BACKFILLED'
     AND event.report_id IS NULL
    WHERE event.id IS NULL
  ) OR EXISTS (
    SELECT revision_id
    FROM external_revision_classification_events
    WHERE actor_kind='synchronization'
      AND actor_id='migration-010'
      AND reason_code='REVISION_CLASSIFICATION_BACKFILLED'
    GROUP BY revision_id
    HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'external revision classification baseline integrity failure';
  END IF;
END;
$$;

ALTER TABLE external_curation_decisions
  ALTER COLUMN classification_event_id DROP NOT NULL,
  ADD COLUMN revision_classification_event_id uuid UNIQUE
    REFERENCES external_revision_classification_events(id) ON DELETE RESTRICT,
  ADD CONSTRAINT external_curation_decision_event_subject_exactly_one
    CHECK (num_nonnulls(classification_event_id, revision_classification_event_id) = 1);
