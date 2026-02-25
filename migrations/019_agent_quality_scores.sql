-- Agent Output Quality Scorecards
-- File: 019_agent_quality_scores.sql
-- Created: 2026-02-25

BEGIN;

CREATE TABLE IF NOT EXISTS cortana_quality_scores (
    id BIGSERIAL PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES cortana_tasks(id) ON DELETE CASCADE,
    agent_role TEXT NOT NULL,
    score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
    criteria_results JSONB NOT NULL DEFAULT '{}'::jsonb,
    scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cortana_quality_scores_task_id
    ON cortana_quality_scores(task_id);

CREATE INDEX IF NOT EXISTS idx_cortana_quality_scores_agent_role_scored_at
    ON cortana_quality_scores(agent_role, scored_at DESC);

CREATE INDEX IF NOT EXISTS idx_cortana_quality_scores_scored_at
    ON cortana_quality_scores(scored_at DESC);

COMMIT;
