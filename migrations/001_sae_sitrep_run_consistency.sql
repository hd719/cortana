CREATE TABLE IF NOT EXISTS cortana_sitrep_runs (
  run_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  expected_domains TEXT[],
  actual_domains TEXT[],
  total_keys INT,
  error_count INT DEFAULT 0,
  metadata JSONB DEFAULT '{}'
);

CREATE OR REPLACE VIEW cortana_sitrep_latest_completed AS
WITH latest_run AS (
  SELECT run_id
  FROM cortana_sitrep_runs
  WHERE status = 'completed'
  ORDER BY completed_at DESC NULLS LAST
  LIMIT 1
)
SELECT DISTINCT ON (s.domain, s.key)
  s.*
FROM cortana_sitrep s
JOIN latest_run lr ON s.run_id::text = lr.run_id
ORDER BY s.domain, s.key, s.timestamp DESC;
