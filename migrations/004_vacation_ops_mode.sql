CREATE TABLE IF NOT EXISTS cortana_vacation_windows (
  id BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  timezone TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  prep_recommended_at TIMESTAMPTZ,
  prep_started_at TIMESTAMPTZ,
  prep_completed_at TIMESTAMPTZ,
  enabled_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  disable_reason TEXT,
  trigger_source TEXT NOT NULL DEFAULT 'manual_command',
  created_by TEXT NOT NULL DEFAULT 'hamel',
  config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  state_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cortana_vacation_windows_single_active
  ON cortana_vacation_windows ((status))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_cortana_vacation_windows_status_start
  ON cortana_vacation_windows (status, start_at DESC);

CREATE TABLE IF NOT EXISTS cortana_vacation_runs (
  id BIGSERIAL PRIMARY KEY,
  vacation_window_id BIGINT REFERENCES cortana_vacation_windows(id),
  run_type TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  readiness_outcome TEXT,
  summary_status TEXT,
  summary_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary_text TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'running'
);

CREATE INDEX IF NOT EXISTS idx_cortana_vacation_runs_window_type_started
  ON cortana_vacation_runs (vacation_window_id, run_type, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cortana_vacation_runs_type_started
  ON cortana_vacation_runs (run_type, started_at DESC);

CREATE TABLE IF NOT EXISTS cortana_vacation_check_results (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES cortana_vacation_runs(id) ON DELETE CASCADE,
  system_key TEXT NOT NULL,
  tier SMALLINT NOT NULL,
  status TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  freshness_at TIMESTAMPTZ,
  remediation_attempted BOOLEAN NOT NULL DEFAULT FALSE,
  remediation_succeeded BOOLEAN NOT NULL DEFAULT FALSE,
  autonomy_incident_id BIGINT,
  incident_key TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_cortana_vacation_check_results_run
  ON cortana_vacation_check_results (run_id);

CREATE INDEX IF NOT EXISTS idx_cortana_vacation_check_results_system_tier_observed
  ON cortana_vacation_check_results (system_key, tier, observed_at DESC);

CREATE TABLE IF NOT EXISTS cortana_vacation_incidents (
  id BIGSERIAL PRIMARY KEY,
  vacation_window_id BIGINT NOT NULL REFERENCES cortana_vacation_windows(id) ON DELETE CASCADE,
  run_id BIGINT REFERENCES cortana_vacation_runs(id),
  latest_check_result_id BIGINT REFERENCES cortana_vacation_check_results(id),
  latest_action_id BIGINT,
  system_key TEXT NOT NULL,
  tier SMALLINT NOT NULL,
  status TEXT NOT NULL,
  human_required BOOLEAN NOT NULL DEFAULT FALSE,
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolution_reason TEXT,
  symptom TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cortana_vacation_incidents_open_system_window
  ON cortana_vacation_incidents (vacation_window_id, system_key)
  WHERE status IN ('open', 'degraded', 'human_required');

CREATE INDEX IF NOT EXISTS idx_cortana_vacation_incidents_window_status
  ON cortana_vacation_incidents (vacation_window_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cortana_vacation_incidents_system_window_state
  ON cortana_vacation_incidents (system_key, vacation_window_id, status);

CREATE TABLE IF NOT EXISTS cortana_vacation_actions (
  id BIGSERIAL PRIMARY KEY,
  vacation_window_id BIGINT NOT NULL REFERENCES cortana_vacation_windows(id) ON DELETE CASCADE,
  run_id BIGINT REFERENCES cortana_vacation_runs(id),
  autonomy_incident_id BIGINT,
  incident_key TEXT,
  system_key TEXT NOT NULL,
  step_order SMALLINT NOT NULL,
  action_kind TEXT NOT NULL,
  action_status TEXT NOT NULL,
  verification_status TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE cortana_vacation_incidents
  ADD CONSTRAINT cortana_vacation_incidents_latest_action_fk
  FOREIGN KEY (latest_action_id)
  REFERENCES cortana_vacation_actions(id);

CREATE INDEX IF NOT EXISTS idx_cortana_vacation_actions_incident_window
  ON cortana_vacation_actions (incident_key, vacation_window_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cortana_vacation_actions_system_window
  ON cortana_vacation_actions (system_key, vacation_window_id, started_at DESC);
