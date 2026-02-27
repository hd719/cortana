CREATE TABLE IF NOT EXISTS cortana_run_events (
  id SERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id INTEGER REFERENCES cortana_tasks(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('queued', 'running', 'completed', 'failed', 'timeout', 'killed', 'reconciled_unknown')),
  source TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON cortana_run_events(run_id);
CREATE INDEX IF NOT EXISTS idx_run_events_task_id ON cortana_run_events(task_id);
