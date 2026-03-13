# Proprioception

Cortana's self-awareness system. Maintains a real-time model of her own health, budget, and operational state — the way a body knows where its limbs are without looking.

> "Proprioception: the sense that lets you know your own body's position, motion, and state. Cortana needs the same — not for the world (that's SAE), but for herself."

## Architecture

```
Data Sources
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│  OpenAI │ │  Cron    │ │  Tools   │ │ Feedback │ │ Session  │
│  Usage  │ │  States  │ │  Health  │ │ Signals  │ │  Files   │
└────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
     │            │            │            │            │
     └────────────┴────────────┴────────────┴────────────┘
                               │
                               ▼
              ┌────────────────────────────────┐
              │     PROPRIOCEPTION ENGINE      │
              │        (cron, every 30 min)    │
              │                                │
              │  ┌──────────┐  ┌────────────┐  │
              │  │ Gatherer │→ │  Assessor  │  │
              │  │ (shell)  │  │  (shell)   │  │
              │  └──────────┘  └─────┬──────┘  │
              │                      │         │
              │                ┌─────▼──────┐  │
              │                │ Self-Model │  │
              │                │  (upsert)  │  │
              │                └─────┬──────┘  │
              │                      │         │
              │                ┌─────▼──────┐  │
              │                │ Throttler  │  │
              │                │ (if needed)│  │
              │                └────────────┘  │
              └────────────────────────────────┘
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
             cortana_self  SAE sitrep  Telegram
              _model       (consumer)  (alerts)

── Watchdog (shell, every 15 min) ──────────────────────
  Absorbed into Proprioception as the Gatherer component.
  Pure shell, $0 cost. No LLM involved.
```

## Components

### 1. Budget Tracker (`budget-tracker.sh`)
**Interval:** Every 30 min (shell, $0)

Reads OpenAI usage data (Anthropic only as fallback) and computes:
- **Spend to date** this billing cycle
- **Burn rate** (daily average, 7-day rolling)
- **Projected monthly spend** (burn rate × days remaining)
- **Per-category breakdown** from session labels: `main`, `cron:*`, `subagent:*`, `covenant:*`
- **Threshold alerts** at 50%, 75%, 90% of $200 budget

Source: `node ~/Developer/cortana/skills/telegram-usage/handler.js` + session file sizes as proxy for token volume.

### 2. Cron Health Monitor (`cron-health.sh`)
**Interval:** Every 15 min (shell, $0) — replaces watchdog's cron check

For each cron in `~/.openclaw/cron/*.state.json`:
- Last run time, exit status, consecutive failures
- **Silent failure detection**: if `lastRun` is older than 2× the expected interval → flag as missed
- **Duration tracking**: log run times to `cortana_cron_health`, detect trends (>2σ from mean = anomaly)

### 3. Tool Health Prober (`tool-prober.sh`)
**Interval:** Every 15 min (shell, $0) — replaces watchdog's tool checks

Smoke-tests each external dependency:

| Tool | Check | Timeout |
|------|-------|---------|
| PostgreSQL | `SELECT 1` | 5s |
| Whoop | `GET localhost:3033/whoop/data` | 10s |
| Tonal | `GET localhost:3033/tonal/health` | 10s |
| gog (Gmail) | `gog gmail search 'newer_than:1d' --max 1` | 5s |
| Weather | `curl wttr.in/?format=3` | 5s |

Results logged to `cortana_tool_health`. Self-heal logic preserved from watchdog (Tonal token reset, etc.).

### 4. Efficiency Analyzer (`efficiency.sh`)
**Interval:** Daily at 2:30 AM (shell, reads DB — $0)

Queries accumulated data to compute:
- **Token cost per cron** (from session file sizes × estimated $/token)
- **Top 5 most expensive crons** this week
- **Sub-agent spawn rate and cost distribution**
- **Brief engagement rate**: did Hamel respond/react within 2h of a brief? (from `cortana_feedback_signals`)
- **Wake rule ROI**: trigger count × engagement rate / token cost

### 5. Self-Model Writer (`self-model.sh`)
**Interval:** Every 30 min (shell, upserts to DB — $0)

Aggregates all data into `cortana_self_model` — a single-row table (like `cortana_chief_model` but for Cortana):

```
┌─────────────────────────────────────────────┐
│             cortana_self_model               │
├─────────────────────────────────────────────┤
│ health_score: 87/100                        │
│ status: "nominal"                           │
│ budget_pct_used: 42.3                       │
│ budget_burn_rate: 3.21/day                  │
│ budget_projected: $89.60                    │
│ throttle_tier: 0 (normal)                   │
│ crons_total: 27                             │
│ crons_healthy: 25                           │
│ crons_failing: ["memory-consolidation"]     │
│ crons_missed: []                            │
│ tools_up: ["pg","whoop","gog","weather"]    │
│ tools_down: ["tonal"]                       │
│ top_cost_crons: {"morning-brief": 0.42, …} │
│ brief_engagement: 0.73                      │
│ alerts: ["Tonal down 2h", "Budget 75%"]     │
│ updated_at: 2026-02-17T10:30:00Z            │
└─────────────────────────────────────────────┘
```

### 6. Auto-Throttler (`throttle.sh`)
**Interval:** Runs as part of self-model writer when thresholds crossed

See [Auto-Throttle Tiers](#auto-throttle-tiers) below.

## PostgreSQL Schema

```sql
-- Cortana's self-model (single row, upserted)
CREATE TABLE cortana_self_model (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
    health_score INT NOT NULL DEFAULT 100,          -- 0-100
    status TEXT NOT NULL DEFAULT 'nominal',          -- nominal, degraded, critical
    budget_used NUMERIC(8,2) DEFAULT 0,
    budget_pct_used NUMERIC(5,2) DEFAULT 0,
    budget_burn_rate NUMERIC(6,2) DEFAULT 0,         -- $/day rolling avg
    budget_projected NUMERIC(8,2) DEFAULT 0,          -- projected month-end
    throttle_tier INT NOT NULL DEFAULT 0,             -- 0-3
    crons_total INT DEFAULT 0,
    crons_healthy INT DEFAULT 0,
    crons_failing TEXT[] DEFAULT '{}',
    crons_missed TEXT[] DEFAULT '{}',
    tools_up TEXT[] DEFAULT '{}',
    tools_down TEXT[] DEFAULT '{}',
    top_cost_crons JSONB DEFAULT '{}',
    brief_engagement NUMERIC(4,2) DEFAULT 0,          -- 0.0-1.0
    alerts TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO cortana_self_model (id) VALUES (1);

-- Budget tracking over time
CREATE TABLE cortana_budget_log (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    spend_to_date NUMERIC(8,2),
    burn_rate NUMERIC(6,2),
    projected NUMERIC(8,2),
    breakdown JSONB DEFAULT '{}',    -- {"main": 12.5, "cron:morning-brief": 4.2, ...}
    pct_used NUMERIC(5,2)
);

CREATE INDEX idx_budget_log_ts ON cortana_budget_log(timestamp DESC);

-- Cron health history
CREATE TABLE cortana_cron_health (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cron_name TEXT NOT NULL,
    status TEXT NOT NULL,              -- ok, failed, missed
    consecutive_failures INT DEFAULT 0,
    run_duration_sec NUMERIC(8,2),
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_cron_health_name ON cortana_cron_health(cron_name, timestamp DESC);

-- Tool availability history
CREATE TABLE cortana_tool_health (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tool_name TEXT NOT NULL,
    status TEXT NOT NULL,              -- up, down, degraded
    response_ms INT,
    error TEXT,
    self_healed BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_tool_health_name ON cortana_tool_health(tool_name, timestamp DESC);

-- Throttle event log
CREATE TABLE cortana_throttle_log (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tier_from INT NOT NULL,
    tier_to INT NOT NULL,
    reason TEXT NOT NULL,
    actions_taken TEXT[] DEFAULT '{}'  -- ["disabled cron:librarian-scan", "switched model:sonnet→haiku"]
);
```

## Auto-Throttle Tiers

| Tier | Trigger | Actions |
|------|---------|---------|
| **0 — Normal** | Budget < 50% used with projected < $90 | All systems nominal |
| **1 — Conservative** | Budget > 50% OR projected > $90 | Covenant agents switch to haiku. Non-essential crons reduce frequency (2x interval). SAE insights skip low-priority. |
| **2 — Austere** | Budget > 75% OR projected > $95 | Disable Covenant agents except Monitor. Informational crons (RSS, librarian) pause. Sub-agent spawns require priority ≤ 3. Briefs use haiku. |
| **3 — Survival** | Budget > 90% OR projected > $99 | Only critical crons run (morning brief, watchdog, memory consolidation). All models → haiku. No sub-agent spawns. No proactive messages. |

### Throttle Rules
- Tier changes are **logged** to `cortana_throttle_log` and **alerted** to Hamel via Telegram
- Tier can only **increase** automatically; **decrease** requires either: next billing cycle reset, or Hamel manual override
- Tier 3 activates a **kill switch** on all non-essential crons by writing skip files
- Throttle state is stored in `cortana_self_model.throttle_tier`

### Cron Classification

| Priority | Crons | Throttle Behavior |
|----------|-------|-------------------|
| **Critical** | morning-brief, watchdog/proprioception, memory-consolidation, cortical-loop evaluator | Never disabled |
| **Important** | fitness-briefs, stock-brief, SAE world-state, SAE reasoner | Tier 2: reduce frequency. Tier 3: haiku only |
| **Enhancement** | covenant agents, RSS scan, librarian, learning-loop | Tier 1: reduce frequency. Tier 2+: disabled |

## Cron Schedule

| Component | Schedule | Cost |
|-----------|----------|------|
| `cron-health.sh` | Every 15 min | $0 (shell) |
| `tool-prober.sh` | Every 15 min | $0 (shell) |
| `budget-tracker.sh` | Every 30 min | $0 (shell) |
| `self-model.sh` | Every 30 min | $0 (shell) |
| `efficiency.sh` | Daily 2:30 AM | $0 (shell) |

**Total LLM cost: $0.** Everything is pure shell + SQL. The whole point: Cortana monitors herself without spending tokens to do it.

## Integration

### ← Watchdog (Absorbed)
The existing `~/Desktop/services/watchdog/watchdog.sh` is fully absorbed:
- Cron health check → `cron-health.sh`
- Tool smoke tests → `tool-prober.sh`
- Budget guard → `budget-tracker.sh`
- Heartbeat pileup check → `cron-health.sh`
- Telegram alerting → preserved, unified in `self-model.sh`

After migration, watchdog.sh becomes a thin wrapper calling proprioception scripts, then is retired.

### → SAE (Consumer)
SAE's world-state builder adds a **"system" domain** reading from `cortana_self_model`:
```sql
-- SAE pulls self-model into sitrep
INSERT INTO cortana_sitrep (run_id, domain, key, value)
SELECT $run_id, 'system', 'self_model', row_to_json(s)::jsonb
FROM cortana_self_model s;
```

Morning brief gains a **⚙️ System Health** section when status ≠ nominal.

### → Cortical Loop (Wake Source)
New wake rule: proprioception events (tool down, budget threshold, cron failure streak) can trigger LLM wake for intelligent response.

```sql
INSERT INTO cortana_wake_rules (name, description, source, event_type, priority, suppress_when)
VALUES ('proprioception_alert', 'Self-model health degraded', 'proprioception', 'health_degraded', 2, '{"chief_state": "asleep"}');
```

### → Memory Consolidation
Nightly consolidation reviews `cortana_throttle_log` and `cortana_cron_health` for patterns worth remembering (e.g., "Tonal goes down every Tuesday" → log to patterns).

### → Covenant Agents
Monitor agent can query `cortana_self_model` for anomaly detection across Cortana's own operational data, not just external patterns.

## Health Score Calculation

```
health_score = 100
  - (10 × len(tools_down))           # each down tool = -10
  - (5  × len(crons_failing))        # each failing cron = -5
  - (15 × len(crons_missed))         # each missed cron = -15
  - throttle_penalty                  # tier 1: -5, tier 2: -15, tier 3: -30
  - budget_penalty                    # >75%: -5, >90%: -15

status:
  >= 80  → "nominal"
  50-79  → "degraded"
  < 50   → "critical"
```

## Example Self-Model Output

```json
{
  "health_score": 82,
  "status": "nominal",
  "budget_used": 47.30,
  "budget_pct_used": 47.3,
  "budget_burn_rate": 3.15,
  "budget_projected": 88.20,
  "throttle_tier": 0,
  "crons_total": 27,
  "crons_healthy": 26,
  "crons_failing": ["covenant-oracle"],
  "crons_missed": [],
  "tools_up": ["postgresql", "whoop", "gog", "weather"],
  "tools_down": ["tonal"],
  "top_cost_crons": {
    "morning-brief": 0.48,
    "sae-reasoner": 0.31,
    "fitness-morning": 0.22,
    "covenant-huragok": 0.19,
    "stock-brief": 0.15
  },
  "brief_engagement": 0.71,
  "alerts": [
    "Tonal API down since 09:15",
    "covenant-oracle: 3 consecutive failures"
  ],
  "updated_at": "2026-02-17T10:30:00-05:00"
}
```

## Files

- `README.md` — This file
- `budget-tracker.sh` — OpenAI spend tracking (Anthropic fallback)
- `cron-health.sh` — Cron state monitoring + silent failure detection
- `tool-prober.sh` — External API health checks + self-heal
- `self-model.sh` — Aggregator, writes cortana_self_model + alerts
- `efficiency.sh` — Daily cost analysis and engagement metrics
- `throttle.sh` — Auto-throttle tier management
- `schema.sql` — PostgreSQL table definitions
