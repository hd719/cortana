-- Immune System schema for Cortana
-- Incident log and Playbook registry

CREATE TABLE IF NOT EXISTS cortana_immune_incidents (
    id SERIAL PRIMARY KEY,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    threat_type TEXT NOT NULL,
    source TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    description TEXT NOT NULL,
    threat_signature TEXT,
    tier INT NOT NULL,
    status TEXT NOT NULL DEFAULT 'detected',
    playbook_used TEXT,
    resolution TEXT,
    auto_resolved BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_immune_incidents_detected ON cortana_immune_incidents(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_immune_incidents_status ON cortana_immune_incidents(status) WHERE status != 'resolved';
CREATE INDEX IF NOT EXISTS idx_immune_incidents_signature ON cortana_immune_incidents(threat_signature);

CREATE TABLE IF NOT EXISTS cortana_immune_playbooks (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    threat_signature TEXT NOT NULL,
    description TEXT NOT NULL,
    actions JSONB NOT NULL,
    tier INT NOT NULL DEFAULT 1,
    enabled BOOLEAN DEFAULT TRUE,
    times_used INT DEFAULT 0,
    last_used TIMESTAMPTZ,
    success_rate NUMERIC(4,2) DEFAULT 1.0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_immune_playbooks_signature ON cortana_immune_playbooks(threat_signature);
