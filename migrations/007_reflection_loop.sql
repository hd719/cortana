-- Reflection & Correction Learning Loop
-- File: 007_reflection_loop.sql
-- Created: 2026-02-24

BEGIN;

CREATE TABLE IF NOT EXISTS cortana_reflection_runs (
    id SERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    trigger_source TEXT NOT NULL DEFAULT 'manual', -- manual|heartbeat|post_task|cron
    mode TEXT NOT NULL DEFAULT 'sweep',            -- sweep|task
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','noop')),
    window_days INT NOT NULL DEFAULT 30,
    feedback_rows INT NOT NULL DEFAULT 0,
    reflected_tasks INT NOT NULL DEFAULT 0,
    rules_extracted INT NOT NULL DEFAULT 0,
    rules_auto_applied INT NOT NULL DEFAULT 0,
    repeated_correction_rate NUMERIC(6,2) NOT NULL DEFAULT 0,
    summary TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_reflection_runs_started_at
    ON cortana_reflection_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS cortana_task_reflections (
    id SERIAL PRIMARY KEY,
    task_id INT REFERENCES cortana_tasks(id) ON DELETE CASCADE,
    reflected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    outcome_type TEXT NOT NULL CHECK (outcome_type IN ('success','failure','near_miss','unknown')),
    signal_score NUMERIC(5,2) NOT NULL DEFAULT 0,
    lesson TEXT,
    evidence JSONB NOT NULL DEFAULT '{}',
    UNIQUE(task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_reflections_reflected_at
    ON cortana_task_reflections(reflected_at DESC);

CREATE TABLE IF NOT EXISTS cortana_reflection_rules (
    id SERIAL PRIMARY KEY,
    feedback_type VARCHAR(50) NOT NULL,
    rule_text TEXT NOT NULL,
    confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
    evidence_count INT NOT NULL DEFAULT 1,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applied','rejected')),
    target_file TEXT,
    applied_at TIMESTAMPTZ,
    source_run_id INT REFERENCES cortana_reflection_runs(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    UNIQUE(feedback_type, rule_text)
);

CREATE INDEX IF NOT EXISTS idx_reflection_rules_status_conf
    ON cortana_reflection_rules(status, confidence DESC);

CREATE TABLE IF NOT EXISTS cortana_reflection_journal (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    run_id INT REFERENCES cortana_reflection_runs(id) ON DELETE SET NULL,
    entry_type TEXT NOT NULL,  -- task_reflection|rule_extraction|policy_update|kpi|error
    title TEXT NOT NULL,
    body TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_reflection_journal_created_at
    ON cortana_reflection_journal(created_at DESC);

COMMIT;
