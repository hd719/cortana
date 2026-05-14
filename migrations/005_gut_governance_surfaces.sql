BEGIN;

DROP TABLE IF EXISTS mc_approval_events CASCADE;
DROP TABLE IF EXISTS mc_approval_requests CASCADE;

DROP VIEW IF EXISTS cortana_feedback CASCADE;
DROP TABLE IF EXISTS mc_feedback_legacy_ids CASCADE;
DROP TABLE IF EXISTS mc_feedback_actions CASCADE;
DROP TABLE IF EXISTS mc_feedback_items CASCADE;

DROP TABLE IF EXISTS cortana_decision_traces CASCADE;
DROP TABLE IF EXISTS cortana_decisions CASCADE;

DROP TABLE IF EXISTS cortana_autonomy_scorecard_snapshots CASCADE;

ALTER TABLE IF EXISTS cortana_vacation_check_results
  DROP COLUMN IF EXISTS autonomy_incident_id,
  DROP COLUMN IF EXISTS incident_key;

ALTER TABLE IF EXISTS cortana_vacation_actions
  DROP COLUMN IF EXISTS autonomy_incident_id,
  DROP COLUMN IF EXISTS incident_key;

COMMIT;
