BEGIN;

CREATE TABLE IF NOT EXISTS cortana_memory_ingest_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','failed')),
  source TEXT NOT NULL DEFAULT 'heartbeat',
  since_hours INT,
  inserted_episodic INT NOT NULL DEFAULT 0,
  inserted_semantic INT NOT NULL DEFAULT 0,
  inserted_procedural INT NOT NULL DEFAULT 0,
  inserted_provenance INT NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_memory_ingest_runs_started ON cortana_memory_ingest_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS cortana_memory_episodic (
  id BIGSERIAL PRIMARY KEY,
  happened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary TEXT NOT NULL,
  details TEXT,
  participants TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  salience NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (salience >= 0 AND salience <= 1),
  trust NUMERIC(4,3) NOT NULL DEFAULT 0.6 CHECK (trust >= 0 AND trust <= 1),
  recency_weight NUMERIC(4,3) NOT NULL DEFAULT 1.0 CHECK (recency_weight >= 0 AND recency_weight <= 1),
  source_type TEXT NOT NULL,
  source_ref TEXT,
  fingerprint TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_type, source_ref, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_memory_episodic_happened ON cortana_memory_episodic(happened_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_episodic_tags ON cortana_memory_episodic USING GIN(tags);

CREATE TABLE IF NOT EXISTS cortana_memory_semantic (
  id BIGSERIAL PRIMARY KEY,
  fact_type TEXT NOT NULL CHECK (fact_type IN ('fact','preference','rule','relationship')),
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_value TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
  trust NUMERIC(4,3) NOT NULL DEFAULT 0.75 CHECK (trust >= 0 AND trust <= 1),
  stability NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (stability >= 0 AND stability <= 1),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_type TEXT NOT NULL,
  source_ref TEXT,
  fingerprint TEXT,
  supersedes_memory_id BIGINT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (fact_type, subject, predicate, object_value)
);
CREATE INDEX IF NOT EXISTS idx_memory_semantic_subject_predicate ON cortana_memory_semantic(subject, predicate);

CREATE TABLE IF NOT EXISTS cortana_memory_procedural (
  id BIGSERIAL PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  trigger_context TEXT,
  steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_outcome TEXT,
  derived_from_feedback_id BIGINT,
  trust NUMERIC(4,3) NOT NULL DEFAULT 0.85 CHECK (trust >= 0 AND trust <= 1),
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  fingerprint TEXT,
  deprecated BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (workflow_name, trigger_context, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_memory_procedural_name ON cortana_memory_procedural(workflow_name);

CREATE TABLE IF NOT EXISTS cortana_memory_provenance (
  id BIGSERIAL PRIMARY KEY,
  memory_tier TEXT NOT NULL CHECK (memory_tier IN ('episodic','semantic','procedural')),
  memory_id BIGINT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  source_hash TEXT,
  ingest_run_id BIGINT REFERENCES cortana_memory_ingest_runs(id) ON DELETE SET NULL,
  extractor_version TEXT NOT NULL DEFAULT 'v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (memory_tier, memory_id, source_type, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_memory_provenance_tier_id ON cortana_memory_provenance(memory_tier, memory_id);

CREATE TABLE IF NOT EXISTS cortana_memory_archive (
  id BIGSERIAL PRIMARY KEY,
  memory_tier TEXT NOT NULL CHECK (memory_tier IN ('episodic','semantic','procedural')),
  memory_id BIGINT NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (memory_tier, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_archive_tier_archived ON cortana_memory_archive(memory_tier, archived_at DESC);

COMMIT;
