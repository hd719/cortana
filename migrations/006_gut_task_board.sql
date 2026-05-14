BEGIN;

ALTER TABLE IF EXISTS cortana_agent_feedback
  DROP COLUMN IF EXISTS source_task_id;

ALTER TABLE IF EXISTS cortana_council_sessions
  DROP COLUMN IF EXISTS related_task_id;

ALTER TABLE IF EXISTS cortana_proactive_signals
  DROP COLUMN IF EXISTS related_task_id;

ALTER TABLE IF EXISTS cortana_proactive_suggestions
  DROP COLUMN IF EXISTS related_task_id;

ALTER TABLE IF EXISTS cortana_response_evaluations
  DROP COLUMN IF EXISTS task_id;

ALTER TABLE IF EXISTS cortana_run_events
  DROP COLUMN IF EXISTS task_id;

ALTER TABLE IF EXISTS cortana_trace_spans
  DROP COLUMN IF EXISTS task_id;

DROP TABLE IF EXISTS cortana_task_reflections CASCADE;
DROP TABLE IF EXISTS cortana_quality_scores CASCADE;
DROP TABLE IF EXISTS cortana_tasks CASCADE;
DROP TABLE IF EXISTS cortana_epics CASCADE;

COMMIT;
