# Immune System

Cortana's self-defense, threat detection, and auto-healing layer. When something breaks — credential failures, API errors, budget burns, silent cron deaths — the Immune System detects, responds, and remembers.

> "Like a biological immune system: detect threats, neutralize them, and build antibodies so the next encounter is faster."

## Operating Philosophy

**The immune system is never disabled as a fix.** If something in the immune system is misbehaving — a playbook misfiring, false positives, a scan burning tokens — we diagnose it, ask questions, and iterate. Turning it off is not a solution. Break the problem down, narrow the scope, try a different approach. The system exists to protect Cortana; disabling it leaves us blind.

## Architecture

```
Data Sources (Proprioception, Cortical Loop, Cron Events, Tool Health, Budget)
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│                   IMMUNE SYSTEM                           │
│                                                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │   Threat    │→ │  Playbook   │→ │   Escalation    │  │
│  │  Detector   │  │  Executor   │  │   Router        │  │
│  │             │  │             │  │                 │  │
│  │ credentials │  │ auto-heal   │  │ Tier 1: silent  │  │
│  │ API errors  │  │ restart     │  │ Tier 2: notify  │  │
│  │ budget burn │  │ token reset │  │ Tier 3: alert   │  │
│  │ cron death  │  │ quarantine  │  │                 │  │
│  │ anomalies   │  │             │  │                 │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
│         │                │                │              │
│         ▼                ▼                ▼              │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Antibody Memory                      │   │
│  │                                                    │   │
│  │  cortana_immune_incidents — every incident logged  │   │
│  │  cortana_immune_playbooks — known fix patterns     │   │
│  │                                                    │   │
│  │  Same threat seen before? → auto-resolve faster    │   │
│  │  New threat? → escalate, then save the playbook    │   │
│  └──────────────────────────────────────────────────┘   │
│         │                                               │
│         ▼                                               │
│  ┌──────────────┐                                       │
│  │  Quarantine  │                                       │
│  │              │                                       │
│  │  Disable     │                                       │
│  │  runaway     │                                       │
│  │  components  │                                       │
│  │  before they │                                       │
│  │  cascade     │                                       │
│  └──────────────┘                                       │
└──────────────────────────────────────────────────────────┘
    │              │              │
    ▼              ▼              ▼
cortana_immune  cortana_immune  Telegram
_incidents      _playbooks      (alerts)
```

## Components

### 1. Threat Detector

Scans for anomalies across all Cortana subsystems. Reads from existing tables — no new data collection needed.

| Threat Type | Source Table | Detection Logic |
|-------------|-------------|-----------------|
| **Credential failure** | `cortana_events` | `event_type = 'auth_failure'` or error messages containing auth/token/401/403 |
| **API errors** | `cortana_tool_health` | `status = 'down'` for >30 min, or 3+ consecutive failures |
| **Budget burn** | `cortana_self_model` | `budget_burn_rate` > 2× rolling 7-day average, or budget_pct_used jumps >5% in 24h |
| **Silent cron failure** | `cortana_cron_health` | `consecutive_failures >= 3` or status = 'missed' |
| **Token runaway** | `cortana_budget_log` | Single cron category burn spikes >10× its 7-day average |
| **Cascade risk** | `cortana_tool_health` | 3+ tools down simultaneously |
| **Repeated errors** | `cortana_events` | Same `(event_type, source)` appearing 5+ times in 1 hour |

### 2. Playbook Executor

Unified response system. Currently auto-healing is scattered (Tonal token delete in tool-prober, session cleanup in its own cron, etc.). The Immune System consolidates all response patterns into `cortana_immune_playbooks`.

#### Built-In Playbooks

| Playbook | Trigger | Action | Tier |
|----------|---------|--------|------|
| `tonal_token_reset` | Tonal auth failure | Delete `~/.tonal/token.json`, restart service | 1 |
| `session_cleanup` | Session files >400KB | Delete bloated session files | 1 |
| `fitness_service_restart` | Port 8080 unresponsive | `brew services restart fitness-service` | 1 |
| `browser_restart` | Port 18800 unresponsive | Restart OpenClaw browser | 1 |
| `cron_unstick` | Cron missed 3+ runs | Log event, check for stuck process, alert | 2 |
| `budget_throttle` | Burn rate spike | Trigger proprioception throttle escalation | 2 |
| `tool_cascade` | 3+ tools down | Quarantine non-essential crons, alert Chief | 3 |
| `runaway_cron` | Cron burning 10× normal tokens | Suspend the cron, alert Chief | 3 |
| `auth_cascade` | 3+ auth failures in 1h | Quarantine affected services, alert Chief | 3 |

### 3. Quarantine

Isolates failing components before they cascade. Quarantine actions:

- **Cron suspension:** Write a skip marker file (`~/.openclaw/cron/<name>.quarantined`) — the immune scan checks these and skips quarantined crons
- **Service isolation:** Stop the failing service, log the action
- **Budget freeze:** Force throttle tier escalation via proprioception

Quarantined items are tracked in `cortana_immune_incidents` with `status = 'quarantined'`. They remain quarantined until manually released or auto-released after the root cause is resolved.

### 4. Antibody Memory

Every incident is logged. When the same threat pattern recurs, the system checks antibody memory first:

```
New threat detected
    │
    ▼
Query cortana_immune_playbooks WHERE threat_signature matches
    │
    ├─ Found (antibody exists) → Execute playbook automatically
    │                            Log as auto-resolved
    │                            Increment playbook.times_used
    │
    └─ Not found (novel threat) → Escalate per tier
                                  If manually resolved, save new playbook
```

**Threat signatures** are `(threat_type, source, pattern)` tuples — e.g., `('auth_failure', 'tonal', 'token_expired')`.

### 5. Escalation Router

| Tier | Criteria | Response |
|------|----------|----------|
| **Tier 1 — Auto-fix** | Known playbook exists, low severity, no cascade risk | Execute silently. Log to `cortana_immune_incidents`. No notification. |
| **Tier 2 — Fix + Notify** | Known playbook but medium severity, or first occurrence of a pattern | Execute the fix, then notify Chief via Telegram: "🛡️ Fixed: [description]" |
| **Tier 3 — Quarantine + Alert** | Unknown threat, high severity, cascade risk, or budget impact >$5 | Quarantine the component. Alert Chief immediately: "🚨 [threat] — quarantined [component], awaiting orders" |

**Escalation logic:**
- `severity = 'low'` + playbook exists → Tier 1
- `severity = 'medium'` OR no playbook but contained → Tier 2
- `severity = 'high'` OR `severity = 'critical'` OR cascade detected → Tier 3
- Any `quarantine` action → always Tier 3

## PostgreSQL Schema

```sql
-- Incident log — every detected threat and its resolution
CREATE TABLE cortana_immune_incidents (
    id SERIAL PRIMARY KEY,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    threat_type TEXT NOT NULL,          -- auth_failure, api_error, budget_burn, cron_failure, token_runaway, cascade, repeated_error
    source TEXT NOT NULL,               -- which component/service (tonal, whoop, cron:morning-brief, etc.)
    severity TEXT NOT NULL DEFAULT 'medium',  -- low, medium, high, critical
    description TEXT NOT NULL,          -- human-readable description
    threat_signature TEXT,              -- normalized pattern for antibody matching
    tier INT NOT NULL,                  -- 1, 2, or 3
    status TEXT NOT NULL DEFAULT 'detected',  -- detected, responding, resolved, quarantined, escalated
    playbook_used TEXT,                 -- which playbook was applied (nullable)
    resolution TEXT,                    -- what was done to fix it
    auto_resolved BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}'         -- extra context (error messages, metrics, etc.)
);

CREATE INDEX idx_immune_incidents_detected ON cortana_immune_incidents(detected_at DESC);
CREATE INDEX idx_immune_incidents_status ON cortana_immune_incidents(status) WHERE status != 'resolved';
CREATE INDEX idx_immune_incidents_signature ON cortana_immune_incidents(threat_signature);

-- Playbook registry — known fix patterns (antibodies)
CREATE TABLE cortana_immune_playbooks (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,          -- tonal_token_reset, session_cleanup, etc.
    threat_signature TEXT NOT NULL,     -- pattern to match against
    description TEXT NOT NULL,
    actions JSONB NOT NULL,             -- ordered list of actions: [{"type": "shell", "command": "..."}, {"type": "sql", "query": "..."}]
    tier INT NOT NULL DEFAULT 1,        -- default escalation tier
    enabled BOOLEAN DEFAULT TRUE,
    times_used INT DEFAULT 0,
    last_used TIMESTAMPTZ,
    success_rate NUMERIC(4,2) DEFAULT 1.0,  -- 0.0-1.0
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_immune_playbooks_signature ON cortana_immune_playbooks(threat_signature);
```

## Cron Schedule

| Component | Schedule | Cost |
|-----------|----------|------|
| `immune-scan` | Every 15 min | ~$0.02/run (sonnet, lightweight) |

**Why LLM?** Unlike proprioception (pure shell, $0), the immune system needs reasoning to:
- Correlate multiple signals into a single threat assessment
- Decide severity and appropriate escalation tier
- Compose meaningful alert messages
- Determine if a novel threat matches an existing playbook pattern

**Cost estimate:** ~$0.02/run × 96 runs/day = ~$1.92/day = ~$58/month. Too high. Instead:

**Hybrid approach:**
- Shell pre-filter (`immune-scan.sh`, $0) runs every 15 min, checks for active threats
- Only invokes LLM cron if threats are detected
- Expected LLM invocations: 2-5/day = ~$0.04-0.10/day = ~$1.50-3.00/month

### immune-scan (OpenClaw cron)

**Schedule:** Every 15 min
**Model:** `anthropic/claude-sonnet-4-20250514`
**Session target:** `isolated`

The cron prompt instructs the LLM to:
1. Query threat sources (incidents, tool health, cron health, budget, events)
2. Match threats against playbooks
3. Execute Tier 1 fixes silently
4. Notify for Tier 2
5. Quarantine + alert for Tier 3
6. Log everything to `cortana_immune_incidents`

## Cron Task Prompt

```markdown
You are Cortana's Immune System — the threat detection and auto-healing layer.

## Your Job
Scan for active threats, match against known playbooks, execute fixes, and escalate when needed.

## Step 1: Detect Threats
Run these queries to find active issues:

```sql
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

-- Recent errors (last 30 min)
SELECT event_type, source, severity, message, metadata
FROM cortana_events
WHERE timestamp > NOW() - INTERVAL '30 minutes'
  AND severity IN ('error', 'critical')
ORDER BY timestamp DESC;

-- Tools currently down
SELECT tool_name, status, error, timestamp
FROM cortana_tool_health
WHERE (tool_name, timestamp) IN (
    SELECT tool_name, MAX(timestamp) FROM cortana_tool_health GROUP BY tool_name
) AND status != 'up';

-- Failing crons (3+ consecutive failures)
SELECT cron_name, status, consecutive_failures, metadata
FROM cortana_cron_health
WHERE (cron_name, timestamp) IN (
    SELECT cron_name, MAX(timestamp) FROM cortana_cron_health GROUP BY cron_name
) AND (consecutive_failures >= 3 OR status = 'missed');

-- Budget anomaly
SELECT health_score, budget_burn_rate, budget_pct_used, budget_projected, throttle_tier, alerts
FROM cortana_self_model WHERE id = 1;

-- Open (unresolved) incidents
SELECT id, threat_type, source, severity, status, detected_at
FROM cortana_immune_incidents
WHERE status NOT IN ('resolved')
ORDER BY detected_at DESC;
```

## Step 2: Match Against Playbooks
For each detected threat, check if a playbook exists:

```sql
SELECT name, actions, tier, success_rate
FROM cortana_immune_playbooks
WHERE enabled = TRUE AND threat_signature = '<threat_signature>';
```

## Step 3: Respond

**Tier 1 (auto-fix silently):** Execute playbook actions. Log incident as auto_resolved.
**Tier 2 (fix + notify):** Execute playbook. Log incident. Send Telegram message: "🛡️ Immune System: Fixed [issue]"
**Tier 3 (quarantine + alert):** Isolate component. Log incident. Send Telegram alert: "🚨 Immune System: [threat] — [component] quarantined"

For each action taken:
```sql
INSERT INTO cortana_immune_incidents (threat_type, source, severity, description, threat_signature, tier, status, playbook_used, resolution, auto_resolved, metadata)
VALUES (...);
```

After using a playbook:
```sql
UPDATE cortana_immune_playbooks SET times_used = times_used + 1, last_used = NOW() WHERE name = '<playbook_name>';
```

## Step 4: Check Quarantined Items
Review quarantined incidents — if root cause appears resolved (tool back up, cron succeeding), auto-release:

```sql
UPDATE cortana_immune_incidents SET status = 'resolved', resolved_at = NOW(), resolution = 'Auto-released: root cause resolved'
WHERE status = 'quarantined' AND id = <id>;
```

## Rules
- If NO threats detected, exit immediately (no output needed)
- Tier 1 fixes: execute and log, no message to Chief
- Tier 2: execute, log, AND notify Chief
- Tier 3: quarantine, log, AND alert Chief with urgency
- Never delete data or drop tables
- When in doubt, escalate (Tier 2 over Tier 1, Tier 3 over Tier 2)
- Log EVERY action to cortana_immune_incidents
```

## Integration Points

### ← Proprioception (Data Source)
Proprioception feeds health data into `cortana_self_model`, `cortana_cron_health`, `cortana_tool_health`, `cortana_budget_log`. The Immune System reads these tables — it doesn't duplicate data collection.

**Relationship:** Proprioception = the nervous system (feels). Immune System = the response (acts).

### ← Cortical Loop (Trigger Source)
The Cortical Loop's event stream (`cortana_event_stream`) can contain events that signal threats (e.g., repeated auth failures). The Immune System reads `cortana_events` for error patterns.

New wake rule for immune alerts:
```sql
INSERT INTO cortana_wake_rules (name, description, source, event_type, priority, suppress_when)
VALUES ('immune_alert', 'Immune System Tier 3 alert', 'immune_system', 'tier3_alert', 1, '{}');
```

### → Memory Consolidation (Pattern Review)
Nightly consolidation reviews `cortana_immune_incidents` for recurring patterns:
- Same threat 3+ times in a week → strengthen the playbook or escalate permanently
- Playbooks with low success_rate → flag for human review
- Seasonal/time-based patterns (e.g., "Tonal auth fails every Tuesday")

### → SAE (System Domain)
The SAE world state builder can include immune status in the "system" domain:
```sql
SELECT COUNT(*) FILTER (WHERE status = 'quarantined') as quarantined,
       COUNT(*) FILTER (WHERE status NOT IN ('resolved') AND detected_at > NOW() - INTERVAL '24h') as active_incidents
FROM cortana_immune_incidents;
```

### → Morning Brief
When active incidents exist, morning brief includes a 🛡️ Immune Status section.

## Example Incident Flow

### Tier 1: Tonal Token Expired
```
1. Proprioception tool-prober detects Tonal down → cortana_tool_health(tonal, down)
2. Immune scan detects: tool down, matches signature 'auth_failure:tonal:token_expired'
3. Playbook found: tonal_token_reset (Tier 1)
4. Execute: rm ~/.tonal/token.json
5. Log: cortana_immune_incidents(auto_resolved=TRUE, tier=1)
6. Playbook updated: times_used++
7. No notification — silent fix
```

### Tier 2: Cron Failing Repeatedly
```
1. Proprioception cron-health detects: morning-brief failed 3x consecutively
2. Immune scan detects: cron_failure, signature 'cron_failure:morning-brief:3+'
3. Playbook found: cron_unstick (Tier 2)
4. Execute: check for stuck process, restart if found
5. Log: cortana_immune_incidents(tier=2)
6. Notify Chief: "🛡️ Fixed: morning-brief was stuck, restarted"
```

### Tier 3: Budget Runaway
```
1. Proprioception budget-tracker detects: burn rate 3× normal
2. Immune scan detects: budget_burn, no exact playbook match
3. Novel threat → Tier 3
4. Quarantine: force throttle tier escalation, suspend top-cost cron
5. Log: cortana_immune_incidents(status='quarantined', tier=3)
6. Alert Chief: "🚨 Budget burn 3× normal — suspended [cron], throttle → Tier 2. Projected $142 at current rate."
```

## Files
- `README.md` — This file (architecture, schema, integration)
- `immune-scan-prompt.md` — Cron task prompt (extracted for cron use)
- `seed-playbooks.sql` — Initial playbook entries
- `schema.sql` — PostgreSQL table definitions
