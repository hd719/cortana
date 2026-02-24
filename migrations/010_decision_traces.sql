CREATE TABLE IF NOT EXISTS cortana_decision_traces (
  id BIGSERIAL PRIMARY KEY,
  trace_id TEXT NOT NULL,
  event_id BIGINT,
  task_id BIGINT,
  run_id TEXT,
  trigger_type TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_name TEXT NOT NULL,
  reasoning TEXT,
  confidence NUMERIC(5,4),
  outcome TEXT NOT NULL DEFAULT 'unknown',
  data_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_traces_trace_id ON cortana_decision_traces(trace_id);
CREATE INDEX IF NOT EXISTS idx_decision_traces_created_at ON cortana_decision_traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_traces_trigger_action ON cortana_decision_traces(trigger_type, action_type);
CREATE INDEX IF NOT EXISTS idx_decision_traces_outcome ON cortana_decision_traces(outcome);
CREATE INDEX IF NOT EXISTS idx_decision_traces_confidence ON cortana_decision_traces(confidence);
CREATE INDEX IF NOT EXISTS idx_decision_traces_data_inputs ON cortana_decision_traces USING GIN(data_inputs);
CREATE INDEX IF NOT EXISTS idx_decision_traces_metadata ON cortana_decision_traces USING GIN(metadata);
