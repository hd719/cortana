-- Autonomy Scorecard migration
-- File: 006_autonomy_scorecard.sql
-- Created: 2026-02-24

BEGIN;

CREATE TABLE IF NOT EXISTS cortana_autonomy_incidents (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    incident_type TEXT NOT NULL,
    source TEXT,
    auto_resolved BOOLEAN NOT NULL DEFAULT FALSE,
    escalated_to_human BOOLEAN NOT NULL DEFAULT FALSE,
    resolution_time_sec NUMERIC(10,2),
    metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_autonomy_incidents_ts ON cortana_autonomy_incidents(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_autonomy_incidents_flags ON cortana_autonomy_incidents(auto_resolved, escalated_to_human);

CREATE TABLE IF NOT EXISTS cortana_proactive_suggestions (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT,
    suggestion TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'useful', 'acted_on', 'ignored', 'rejected')),
    related_task_id INTEGER REFERENCES cortana_tasks(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_proactive_suggestions_ts ON cortana_proactive_suggestions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_proactive_suggestions_status ON cortana_proactive_suggestions(status);

CREATE TABLE IF NOT EXISTS cortana_response_evaluations (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    task_id INTEGER REFERENCES cortana_tasks(id) ON DELETE SET NULL,
    source TEXT,
    evaluator TEXT NOT NULL DEFAULT 'system',
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'partial', 'fail')),
    notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_response_evals_ts ON cortana_response_evaluations(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_response_evals_outcome ON cortana_response_evaluations(outcome);

CREATE TABLE IF NOT EXISTS cortana_memory_recall_checks (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT,
    prompt TEXT,
    expected TEXT,
    actual TEXT,
    correct BOOLEAN NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_memory_checks_ts ON cortana_memory_recall_checks(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_memory_checks_correct ON cortana_memory_recall_checks(correct);

CREATE TABLE IF NOT EXISTS cortana_autonomy_scorecard_snapshots (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_days INTEGER NOT NULL DEFAULT 7,
    score NUMERIC(5,2) NOT NULL,
    self_heal_rate NUMERIC(5,2) NOT NULL,
    proactive_hit_rate NUMERIC(5,2) NOT NULL,
    task_completion_rate NUMERIC(5,2) NOT NULL,
    correction_frequency_score NUMERIC(5,2) NOT NULL,
    response_quality_score NUMERIC(5,2) NOT NULL,
    memory_accuracy NUMERIC(5,2) NOT NULL,
    uptime_score NUMERIC(5,2) NOT NULL,
    metrics JSONB NOT NULL DEFAULT '{}',
    weights JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_autonomy_snapshots_ts ON cortana_autonomy_scorecard_snapshots(timestamp DESC);

CREATE OR REPLACE VIEW cortana_autonomy_scorecard_latest AS
SELECT *
FROM cortana_autonomy_scorecard_snapshots
ORDER BY timestamp DESC
LIMIT 1;

CREATE OR REPLACE VIEW cortana_autonomy_scorecard_daily AS
SELECT
    date_trunc('day', timestamp) AS day,
    ROUND(AVG(score)::numeric, 2) AS avg_score,
    ROUND(AVG(self_heal_rate)::numeric, 2) AS self_heal_rate,
    ROUND(AVG(proactive_hit_rate)::numeric, 2) AS proactive_hit_rate,
    ROUND(AVG(task_completion_rate)::numeric, 2) AS task_completion_rate,
    ROUND(AVG(correction_frequency_score)::numeric, 2) AS correction_frequency_score,
    ROUND(AVG(response_quality_score)::numeric, 2) AS response_quality_score,
    ROUND(AVG(memory_accuracy)::numeric, 2) AS memory_accuracy,
    ROUND(AVG(uptime_score)::numeric, 2) AS uptime_score,
    COUNT(*) AS samples
FROM cortana_autonomy_scorecard_snapshots
GROUP BY 1
ORDER BY 1 DESC;

COMMIT;
