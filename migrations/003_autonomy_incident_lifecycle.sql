CREATE TABLE IF NOT EXISTS cortana_autonomy_incidents (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  incident_type TEXT NOT NULL,
  source TEXT,
  auto_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  escalated_to_human BOOLEAN NOT NULL DEFAULT FALSE,
  resolution_time_sec NUMERIC(10,2),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS incident_key TEXT;
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS system TEXT;
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'warning';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'open';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS remediation_status TEXT NOT NULL DEFAULT 'detected';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS last_detail TEXT NOT NULL DEFAULT '';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS verification TEXT NOT NULL DEFAULT '';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT '';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS occurrence_count INTEGER NOT NULL DEFAULT 0;

UPDATE cortana_autonomy_incidents
SET incident_key = CONCAT('legacy:', id)
WHERE incident_key IS NULL OR incident_key = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_cortana_autonomy_incidents_incident_key
  ON cortana_autonomy_incidents (incident_key);

CREATE INDEX IF NOT EXISTS idx_cortana_autonomy_incidents_state_seen
  ON cortana_autonomy_incidents (state, last_seen_at DESC);
