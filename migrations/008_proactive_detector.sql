-- Proactive Opportunity Detector schema
-- File: 008_proactive_detector.sql
-- Created: 2026-02-24

BEGIN;

CREATE TABLE IF NOT EXISTS cortana_proactive_detector_runs (
    id BIGSERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
    signals_total INT NOT NULL DEFAULT 0,
    signals_gated INT NOT NULL DEFAULT 0,
    suggestions_created INT NOT NULL DEFAULT 0,
    errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_proactive_detector_runs_started
    ON cortana_proactive_detector_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS cortana_proactive_signals (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT REFERENCES cortana_proactive_detector_runs(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
    opportunity BOOLEAN NOT NULL DEFAULT TRUE,
    starts_at TIMESTAMPTZ,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','surfaced','actioned','dismissed')),
    related_task_id INTEGER REFERENCES cortana_tasks(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_proactive_signals_fingerprint
    ON cortana_proactive_signals(fingerprint);

CREATE INDEX IF NOT EXISTS idx_proactive_signals_conf
    ON cortana_proactive_signals(confidence DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_proactive_signals_source_type
    ON cortana_proactive_signals(source, signal_type);

CREATE INDEX IF NOT EXISTS idx_proactive_signals_starts_at
    ON cortana_proactive_signals(starts_at);

COMMIT;
