# Cortana Control-Plane Resilience Assessment

**Date:** 2026-02-27  
**Scope:** Blast-radius analysis for four failure scenarios across core control-plane components (PostgreSQL, OpenClaw gateway, host hardware, internet).

## Baseline architecture (what exists today)

- **Primary state store:** local PostgreSQL 17 (`cortana` DB).
- **Runtime control plane:** OpenClaw gateway + OpenClaw cron scheduler.
- **Health supervision:** launchd watchdog (`com.cortana.watchdog`) + resilience drillbook (`tools/resilience/drillbook.sh`).
- **Message plane:** Telegram via OpenClaw channel integration.
- **State locations:**
  - Repo config/code/docs: `/Users/hd/clawd` (git-tracked, except ignored runtime artifacts)
  - Runtime/session state: `~/.openclaw/*` (not git-tracked)
  - DB state: local Postgres data directory (not git-tracked)

---

## Scenario 1: PostgreSQL goes down

### What breaks immediately

- **Task board halts** (`cortana_tasks`, `cortana_epics`): cannot create/update/complete tasks.
- **Event logging halts** (`cortana_events`, event bus bridge): telemetry/audit inserts fail.
- **Feedback/learning pipeline halts** (`cortana_feedback`, compiler workflows).
- **Immune system persistence halts** (`cortana_immune_incidents`, `cortana_immune_playbooks`).
- **Budget/proprioception state halts** (`cortana_budget_*`, `cortana_self_model`, `cortana_tool_health`, `cortana_cron_health`).
- **Pattern and behavior tracking halts** (`cortana_patterns`).
- **Council/Mission Control persistence halts** (`cortana_council_*`, `mc_*` tables).

### What degrades gracefully

- Running gateway process can still answer some stateless/local requests.
- Some external tools may still run ad hoc (filesystem/shell reads), but without DB-backed continuity.
- Watchdog still runs as shell process, but DB-backed logs become best-effort/no-op.

### Current recovery path

1. `brew services restart postgresql@17`
2. Validate with `pg_isready` and `psql cortana -c "SELECT 1"`
3. Run `~/clawd/tools/resilience/drillbook.sh recover` to re-check dependent components.

### Recovery time estimate

- **Typical:** 15-90 seconds for local service restart.
- **Worst local corruption case:** 15-60 minutes+ (manual repair/restore).

### What is not backed up today

- No verified automated `pg_dump`/base backup job found in current cron inventory.
- Therefore, **all Postgres-resident ops state is at risk** if disk or cluster is lost:
  - tasks/epics, events, feedback, immune incidents/playbooks, budget history, patterns,
    council records, Mission Control approvals/feedback/council tables, token ledger, traces.

---

## Scenario 2: OpenClaw gateway crashes

### What breaks immediately

- **All OpenClaw crons stop dispatching** (scheduler/control-plane unavailable).
- **Heartbeat workflows stop** (no scheduled heartbeat-driven checks/actions).
- **Telegram message delivery from agent runtime stops** (outbound/inbound handling through gateway runtime fails).
- **Sub-agent orchestration/control via OpenClaw runtime halts.**

### What degrades gracefully

- Postgres remains available; historical state is preserved.
- launchd services outside gateway (e.g., watchdog, fitness service) can remain up.
- Manual operator commands can still inspect/repair environment.

### Current recovery path

1. `openclaw gateway restart`
2. Verify: `openclaw gateway status`
3. Verify scheduler: `openclaw cron list`

### Recovery time estimate

- **Typical:** 10-60 seconds.
- **If config/runtime drift exists:** 5-20 minutes.

### Notable risk observed

- `~/.openclaw/cron/jobs.json` is currently a regular file, not symlinked to repo `config/cron/jobs.json`.
- This can create scheduler-config drift across updates/restarts and weakens deterministic recovery.

---

## Scenario 3: Mac mini hardware failure (total host loss)

### What breaks immediately

- **Total control-plane outage**: gateway, crons, watchdog, fitness service, local DB, all local automation.
- No message delivery, no scheduled briefs/reminders, no self-healing loops.

### What degrades gracefully

- Git-tracked repo content survives if remote origin is current.
- Conceptual system design/docs/migrations survive in git.

### Current recovery path

1. Provision replacement macOS host.
2. Reinstall runtime stack (Homebrew, Node, pnpm, OpenClaw, Postgres, launchd services).
3. Restore repo and configs.
4. Restore Postgres from backup (currently a gap if no dump exists).
5. Rehydrate gateway/cron runtime state and validate via drillbook.

### Recovery time estimate

- **Best case with tested backups/runbook:** 2-6 hours.
- **Current likely case (no DB backup automation):** 1-2 days with data loss.

### What is not backed up today

- Local Postgres data (unless manually dumped outside current observed setup).
- `~/.openclaw` runtime/session state (delivery queue, subagent run state, cron run history, channel offsets, runtime config drift).
- Watchdog local state (`watchdog-state.json`) unless externally copied.
- Any non-committed repo changes.

---

## Scenario 4: Internet outage

### What breaks immediately

- External APIs and network tools fail (Telegram delivery, web search/fetch, cloud integrations, OAuth refreshes).
- Outbound/inbound user communication fails.

### What degrades gracefully

- Local host services still run: Postgres, gateway process, local cron triggering, filesystem tasks.
- Local-only checks can continue (process health, local logs/state).
- Some scheduled jobs may run and fail fast; state can still log locally when DB is up.

### Current recovery path

1. Restore WAN.
2. Confirm gateway + cron + channel reconnect health.
3. Re-run any missed critical jobs manually if needed.

### Recovery time estimate

- **Dependent on ISP/network restore:** minutes to hours.
- **Service reconvergence after WAN returns:** usually 1-10 minutes.

### What is not backed up / resilient here

- No explicit offline message queue replay process documented for user-facing delivery guarantees.
- Heartbeat intent/state continuity across prolonged offline windows is fragile (runtime-state files not durably backed up).

---

## Git coverage vs non-git coverage (verified)

## Covered by git (versioned)

- Core docs, automation code, migrations, tool scripts.
- Repo-level cron definition file: `config/cron/jobs.json` (tracked).
- Knowledge/memory markdown corpus in repo (tracked files).

## Not covered by git

- `~/.openclaw/*` runtime state (sessions, delivery queue, cron run logs, channel offsets, local config mutations).
- Local Postgres database files/content.
- launchd runtime state and host-level installed service metadata.
- Ignored runtime-state files in repo (e.g., `memory/heartbeat-state.json`, `.openclaw/workspace-state.json`).

---

## Concrete mitigations (priority order)

1. **Add automated Postgres backups (P0)**
   - New OpenClaw cron (or launchd) for `pg_dump` at least daily; retain rolling 14-30 days.
   - Store dumps in iCloud/remote encrypted location + local copy.
   - Add weekly restore test to scratch DB (`cortana_restore_test`).

2. **Export critical ops state snapshots (P0)**
   - Nightly export of high-value tables to JSON/CSV:
     - `cortana_tasks`, `cortana_epics`, `cortana_feedback`, `cortana_events` (windowed),
       `cortana_immune_*`, `cortana_budget_*`, `cortana_patterns`, `cortana_council_*`, `mc_*`.
   - Keep last N snapshots off-host.

3. **Reinstate deterministic cron config linkage (P1)**
   - Ensure `~/.openclaw/cron/jobs.json` is symlinked to `config/cron/jobs.json` as intended.
   - Add watchdog check to alert on symlink drift.

4. **Backup `~/.openclaw` critical runtime subset (P1)**
   - Backup curated files: `openclaw.json` (sanitized/encrypted), cron definitions/backups, delivery queue metadata, subagent run index, channel offset files.
   - Exclude secrets unless encrypted-at-rest.

5. **Offline-capable degraded mode (P1)**
   - Add explicit "offline mode" switch for heartbeat/crons:
     - suppress external API calls,
     - continue local health and journaling,
     - queue outbound messages for replay after connectivity returns.

6. **Host disaster recovery runbook hardening (P1)**
   - Produce one-command bootstrap script for new host setup.
   - Include acceptance checks: `drillbook inventory`, `drillbook recover`, sample Telegram send.

7. **RTO/RPO policy targets (P2)**
   - Define explicit targets, e.g. RTO 15m for service faults, RPO 24h max for DB state.
   - Alert if backup freshness exceeds threshold.

---

## Bottom line

The system is **strong for service-level restart recovery** (gateway/postgres/process restarts), but **weak for host-loss and state durability** because Postgres + runtime state backup/replay is incomplete. The highest leverage fix is immediate: automated `pg_dump` + tested restore + critical runtime state export.