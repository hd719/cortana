# Cortana Workspace (`~/clawd`)

Operational home for Cortana (main orchestrator session + memory + policies + cron prompts + local automation tooling).

This repo is the **brain + playbook** side of the system. Runtime services (Go APIs, mission-control UI, watchdog) live in `~/Developer/cortana-external`.

---

## 1) What this repo is

This workspace contains:
- identity + behavior policy (`SOUL.md`, `AGENTS.md`, `USER.md`, `IDENTITY.md`)
- long/short memory (`MEMORY.md`, `memory/`)
- cron-driven prompt/instruction system for daily operations
- local automation scripts (`tools/`) for task board, reflection, policy, tracing, proactive detection, etc.
- architecture docs for SAE, cortical loop, proprioception, immune system
- installed local skills under `skills/`

If you’re onboarding fresh: start with **`AGENTS.md` → `SOUL.md` → `USER.md` → this README**.

---

## 2) Current top-level layout

```text
~/clawd
├── README.md
├── AGENTS.md                  # Operating rules (dispatcher model, safety, memory routines)
├── SOUL.md                    # Persona/tone contract
├── USER.md                    # Human profile and preferences
├── IDENTITY.md                # Short-form identity card
├── TOOLS.md                   # Local environment + DB table reference
├── MEMORY.md                  # Curated long-term memory
├── HEARTBEAT.md               # Heartbeat checklist/protocol
│
├── skills/                    # Installed local skills (see section 5)
├── tools/                     # Scripts/automation (task board, policy, reflection, guardrails, memory)
├── cortical-loop/             # Event watchers/evaluator state + logs
├── sae/                       # Situational Awareness Engine prompts/templates
├── immune-system/             # Threat detection docs + schema/playbooks
├── proprioception/            # Self-health/budget monitoring docs + scripts
├── memory-consolidation/      # Sleep-cycle memory pipeline docs
│
├── agents/                    # Agent notes/operational assets
├── canvas/                    # Canvas UI assets/workflows
├── covenant/                  # Subagent identities and orchestration notes
├── knowledge/                 # Research/pattern/prediction outputs
├── learning/                  # Learning artifacts/experiments
├── memory/                    # Daily logs + archives
├── migrations/                # SQL migrations for Cortana DB features
├── docs/                      # Runbooks and architecture docs
└── projects/, reports/, tmp/  # Working artifacts
```

---

## 3) System architecture (how pieces fit)

### Core runtime model
1. **Scheduled intelligence (SAE):** world-state snapshots + cross-domain insights
2. **Event-driven loop (cortical-loop):** watchers emit events; evaluator decides if wake is worth it
3. **Self-monitoring (proprioception):** health/budget/throttle state
4. **Auto-healing (immune system):** detect threats, run playbooks, escalate
5. **Memory consolidation:** distill daily logs into long-term memory
6. **Task board:** queued/epic tasks with dependency-aware execution

### Data plane
- Source of truth: **PostgreSQL `cortana`**
- Main working tables include sitrep, insights, events, wake rules, feedback, tasks/epics, health logs, immune incidents/playbooks

---

## 4) Key files you should know

- `AGENTS.md` — operational constitution (includes strict dispatcher rule: main session coordinates, subagents execute)
- `SOUL.md` — voice/personality style contract
- `TOOLS.md` — practical local config and DB table catalog
- `HEARTBEAT.md` — what periodic heartbeat runs should check
- `MEMORY.md` + `memory/YYYY-MM-DD.md` — long vs daily memory
- `sae/*.md` — world-state/reasoning/brief prompt templates
- `proprioception/README.md` + `schema.sql`
- `immune-system/README.md` + `schema.sql` + `seed-playbooks.sql`
- `tools/task-board/` — task board automation + safe auto-executor
- `tools/reflection/reflect.py` — reflection & rule extraction loop
- `tools/policy/engine.py` + `tools/policy/policies.yaml` — policy/risk guardrails

### Tooling updates (2026-02-25)
- `tools/guardrails/tone_drift_sentinel.py` — scores response tone quality against `SOUL.md` alignment targets.
- `tools/task-board/auto_sync_enforcer.py` — forces task-board sync when sub-agents complete work.
- `tools/task-board/state-audit.sql` — PostgreSQL triggers enforcing task lifecycle invariants.
- `tools/task-board/state_integrity.py` — heartbeat-side audit for task state drift and mismatch detection.
- `tools/reflection/recurrence_radar.py` — semantic clustering of repeated corrections for recurrence detection.
- `tools/memory/memory_quality_gate.py` — quality scoring gate for memory entries during ingest.
- `tools/proactive/evaluate_accuracy.py` — tracks precision/accuracy of proactive signals over time.
- `tools/immune_scan.sh` — expanded to include flap detection, quarantine hooks, and path verification.

---

## 5) Installed local skills (from `skills/`)

Current repo-local skills:
- `auto-updater`
- `bird`
- `caldav-calendar`
- `clawddocs`
- `clawdhub`
- `fitness-coach`
- `gog`
- `markets`
- `news-summary`
- `process-watch`
- `telegram-usage`
- `weather`

> Note: additional global skills may exist in the OpenClaw npm skill path; this list is specifically what’s present in this repo.

---

## 6) Active cron landscape (OpenClaw)

Snapshot from `openclaw cron list` on **2026-02-25 09:xx ET**.

### Daily/weekday briefs and core ops
- Morning brief (`07:30`)
- Stock market brief (`07:45`, weekdays)
- Fitness morning brief (`08:03`)
- Fitness evening recap (`20:30`)
- Daily system health summary (`21:12`)
- Bedtime check (`22:18`)
- Newsletter alert (`*/30` between `06:00-16:59`)
- Calendar reminders (`:07` hourly `06:00-23:00`)
- CANSLIM scan (`09:30`, `12:30`, `15:30` weekdays)

### Continuous health / maintenance
- Proprioception checks (`every 15m`) + budget/self-model (`every 30m`)
- Immune scan (`:11` hourly)
- Tonal health (`every 4h`)
- Twitter auth + Amazon session keepalive (`every 8h`)
- X/fitness service healthchecks (`04:00`, `16:00`)
- Session cleanup (`02:00` daily)
- Memory consolidation (`03:12` daily)
- Auto-update (`04:22` daily)
- Weekly status/memory/fitness/market jobs (Sunday windows)

### Current notable statuses (from same snapshot)
- `🎯 Mission Advancement` → **error**
- `🏋️ Fitness Morning Brief` → **error**
- most other recurring jobs → `ok`

Use `openclaw cron list` for live status.

---

## 7) Database tables (current operational groups)

### Core operations
- `cortana_events`
- `cortana_patterns`
- `cortana_feedback`
- `cortana_tasks`
- `cortana_epics`
- `cortana_watchlist`
- `cortana_upgrades`

### SAE + cortical loop
- `cortana_sitrep`
- `cortana_insights`
- `cortana_event_stream`
- `cortana_chief_model`
- `cortana_wake_rules`
- `cortana_feedback_signals`

### Proprioception + budget
- `cortana_self_model`
- `cortana_budget_log`
- `cortana_cron_health`
- `cortana_tool_health`
- `cortana_throttle_log`

### Immune system
- `cortana_immune_incidents`
- `cortana_immune_playbooks`

### Memory/reflection/autonomy (newer autonomy stack)
- `cortana_memory_items`
- `cortana_memory_links`
- `cortana_memory_consolidation`
- `cortana_reflection_runs`
- `cortana_reflection_rules`
- `cortana_autonomy_scorecard`
- `cortana_decision_traces`
- `cortana_policy_audit`
- `cortana_chaos_runs`

Quick DB access:
```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana
```

---

## 8) Integrations this workspace depends on

- **OpenClaw** runtime + cron scheduler
- **PostgreSQL 17** local (`cortana` DB)
- **Fitness/market service** at `http://127.0.0.1:3033` (from `cortana-external`)
- **Google tooling** via `gog` CLI
- **X/Twitter tooling** via `bird`
- **OpenClaw browser** (CDP at `127.0.0.1:18800`, profile managed by OpenClaw)
- **Watchdog launchd service** in external repo (`com.cortana.watchdog`)

---

## 9) Historical context worth keeping

Still relevant timeline points:
- migration from Clawdbot → OpenClaw completed (Feb 2026)
- security hardening pass completed (secret cleanup + git hygiene)
- CANSLIM pipeline integrated and running scheduled scans
- expanded autonomy stack added (memory/reflection/policy/decision tracing/chaos)

---

## 10) Day-1 operator checklist

1. `openclaw cron list` (confirm healthy schedule)
2. verify DB connectivity: `psql cortana -c "select now();"`
3. check `HEARTBEAT.md` + today’s `memory/YYYY-MM-DD.md`
4. scan recent errors:
   ```bash
   psql cortana -c "select timestamp,event_type,severity,message from cortana_events order by timestamp desc limit 20;"
   ```
5. if fitness data is stale, validate external service:
   ```bash
   curl -s http://127.0.0.1:3033/tonal/health
   ```

---

## 11) Maintenance policy for this README

Update this file whenever any of these change:
- top-level architecture or data flow
- installed skills list
- cron schedule/status conventions
- DB schema groups / key operational tables
- integration endpoints (ports/services)

Last refreshed: **2026-02-25**
