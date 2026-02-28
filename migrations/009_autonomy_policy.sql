-- Autonomy Policy Engine
-- File: 009_autonomy_policy.sql
-- Created: 2026-02-24

BEGIN;

CREATE TABLE IF NOT EXISTS cortana_action_policies (
    id BIGSERIAL PRIMARY KEY,
    policy_key TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    description TEXT,
    base_decision TEXT NOT NULL CHECK (base_decision IN ('allow','ask','deny','alert')),
    requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
    risk_base NUMERIC(5,2) NOT NULL DEFAULT 0,
    risk_threshold_ask NUMERIC(5,2) NOT NULL DEFAULT 65,
    risk_threshold_deny NUMERIC(5,2) NOT NULL DEFAULT 90,
    immutable BOOLEAN NOT NULL DEFAULT FALSE,
    constraints JSONB NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_action_policies_category_enabled
    ON cortana_action_policies(category, enabled);

CREATE TABLE IF NOT EXISTS cortana_budget_policies (
    id BIGSERIAL PRIMARY KEY,
    budget_key TEXT NOT NULL UNIQUE,
    cost_type TEXT NOT NULL CHECK (cost_type IN ('tokens','api_usd','tool_calls')),
    scope TEXT NOT NULL DEFAULT 'global', -- global|category|action
    scope_value TEXT,
    window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
    limit_value NUMERIC(14,4) NOT NULL CHECK (limit_value >= 0),
    warn_at_pct NUMERIC(5,2) NOT NULL DEFAULT 80,
    hard_stop BOOLEAN NOT NULL DEFAULT TRUE,
    on_exceed TEXT NOT NULL DEFAULT 'ask' CHECK (on_exceed IN ('allow','alert','ask','deny')),
    metadata JSONB NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budget_policies_type_scope_enabled
    ON cortana_budget_policies(cost_type, scope, enabled);

CREATE TABLE IF NOT EXISTS cortana_policy_overrides (
    id BIGSERIAL PRIMARY KEY,
    override_key TEXT NOT NULL UNIQUE,
    granted_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    action_category TEXT,
    action_key TEXT,
    max_risk_allowed NUMERIC(5,2),
    decision_override TEXT CHECK (decision_override IN ('allow','alert','ask','deny')),
    budget_adjustments JSONB NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_override_scope_nonempty CHECK (
      action_category IS NOT NULL OR action_key IS NOT NULL
    ),
    CONSTRAINT chk_override_valid_window CHECK (expires_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_policy_overrides_active_window
    ON cortana_policy_overrides(active, starts_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_policy_overrides_scope
    ON cortana_policy_overrides(action_category, action_key);

CREATE TABLE IF NOT EXISTS cortana_policy_budget_usage (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cost_type TEXT NOT NULL CHECK (cost_type IN ('tokens','api_usd','tool_calls')),
    action_category TEXT,
    action_key TEXT,
    amount NUMERIC(14,4) NOT NULL CHECK (amount >= 0),
    metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_policy_budget_usage_ts_type
    ON cortana_policy_budget_usage(timestamp DESC, cost_type);
CREATE INDEX IF NOT EXISTS idx_policy_budget_usage_scope
    ON cortana_policy_budget_usage(action_category, action_key);

CREATE TABLE IF NOT EXISTS cortana_policy_decisions (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action_key TEXT,
    action_category TEXT NOT NULL,
    operation TEXT,
    target TEXT,
    requested_by TEXT NOT NULL DEFAULT 'system',
    policy_key TEXT,
    override_key TEXT,
    risk_score NUMERIC(5,2) NOT NULL,
    confidence NUMERIC(5,4),
    budget_snapshot JSONB NOT NULL DEFAULT '{}',
    decision TEXT NOT NULL CHECK (decision IN ('allow','alert','ask','deny')),
    escalation_tier SMALLINT,
    rationale TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_policy_decisions_ts
    ON cortana_policy_decisions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_policy_decisions_decision
    ON cortana_policy_decisions(decision, action_category);

CREATE OR REPLACE VIEW cortana_policy_overrides_active AS
SELECT *
FROM cortana_policy_overrides
WHERE active = TRUE
  AND revoked_at IS NULL
  AND NOW() BETWEEN starts_at AND expires_at;

CREATE OR REPLACE VIEW cortana_policy_decisions_recent AS
SELECT *
FROM cortana_policy_decisions
ORDER BY timestamp DESC
LIMIT 500;

-- Seed baseline policy rows that map existing AGENTS.md tier model.
INSERT INTO cortana_action_policies (
    policy_key, category, description, base_decision, requires_approval, risk_base,
    risk_threshold_ask, risk_threshold_deny, immutable, constraints
)
VALUES
('internal.read', 'internal_read', 'Read/explore local workspace resources', 'allow', FALSE, 5, 70, 95, FALSE, '{}'::jsonb),
('internal.write.safe', 'internal_write', 'Low-impact local writes and organization', 'allow', FALSE, 20, 65, 90, FALSE, '{"paths": ["/Users/hd/openclaw"]}'::jsonb),
('internal.self_heal', 'internal_safe_fix', 'Tier 1 self-healing actions', 'allow', FALSE, 15, 65, 90, FALSE, '{}'::jsonb),
('internal.optimize.alert', 'internal_optimize', 'Tier 2 alert-and-suggest optimizations', 'alert', FALSE, 40, 60, 85, FALSE, '{}'::jsonb),
('external.message', 'external_message', 'Outbound messages/emails/posts', 'ask', TRUE, 70, 55, 80, FALSE, '{}'::jsonb),
('external.publish', 'external_publish', 'Public/external publication actions', 'ask', TRUE, 80, 50, 75, FALSE, '{}'::jsonb),
('change.destructive', 'destructive_change', 'Permanent deletions/destructive mutations', 'ask', TRUE, 85, 45, 70, FALSE, '{}'::jsonb),
('change.infra', 'infra_change', 'Infra/config changes requiring intent confirmation', 'ask', TRUE, 75, 55, 80, FALSE, '{}'::jsonb),
('finance.money_movement', 'money_movement', 'Financial transaction execution', 'deny', TRUE, 95, 40, 60, TRUE, '{}'::jsonb),
('privacy.exfiltration', 'privacy_sensitive', 'Data exfiltration/private data disclosure', 'deny', TRUE, 99, 35, 50, TRUE, '{}'::jsonb)
ON CONFLICT (policy_key) DO NOTHING;

INSERT INTO cortana_budget_policies (
    budget_key, cost_type, scope, scope_value, window_seconds, limit_value,
    warn_at_pct, hard_stop, on_exceed, metadata
)
VALUES
('tokens.global.1h', 'tokens', 'global', NULL, 3600, 120000, 80, TRUE, 'ask', '{}'::jsonb),
('tokens.global.24h', 'tokens', 'global', NULL, 86400, 900000, 85, TRUE, 'ask', '{}'::jsonb),
('api.global.24h', 'api_usd', 'global', NULL, 86400, 25.00, 80, TRUE, 'ask', '{}'::jsonb),
('tools.global.1h', 'tool_calls', 'global', NULL, 3600, 400, 85, FALSE, 'alert', '{}'::jsonb),
('tokens.external.1h', 'tokens', 'category', 'external_message', 3600, 25000, 75, TRUE, 'ask', '{}'::jsonb)
ON CONFLICT (budget_key) DO NOTHING;

COMMIT;
