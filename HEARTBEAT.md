# HEARTBEAT.md – Rotating Checks

**⚠️ CRITICAL COST RULE**: The heartbeat session runs on Opus. Do NOT execute checks inline. Every check that requires tool calls MUST be dispatched to a sub-agent (Codex/GPT-5.1). The heartbeat session reads state, decides what's stale, spawns agents, and reports results. It does NOT do the work itself.

Use `memory/heartbeat-state.json` to pick the stalest 1–2 checks per heartbeat.

## Check Rotation

- **Email triage (2–3× daily)**
  - Run `tools/gmail/email-triage-autopilot.sh` with minimal query.
  - Auto-create tasks in `cortana_tasks` for urgent/action emails.
  - Prepare Telegram digest only (no outbound email).
  - Skip if run within last **4h**.

- **Calendar lookahead (2× daily)**
  - Scan next **24–48h** for conflicts/prep.
  - Skip if run within last **6h**.

- **Portfolio + market (1–2× daily, market hours)**
  - Use Alpaca on port **3033** and `tools/market-intel/market-intel.sh --pulse`.
  - Watch for >3% movers, earnings surprises, >60% bearish sentiment on held positions.
  - **X sentiment scan** (via `bird` skill + @Cortana356047 browser session):
    - Scan X for sentiment on held positions (TSLA, NVDA, and any active CANSLIM candidates).
    - Track key finance accounts for trade ideas, earnings surprises, sector rotation signals.
    - Flag >60% bearish sentiment or unusual volume of negative posts on held positions.
    - Use `bird` CLI for search/mentions; fall back to browser if needed.
  - Only 09:30–16:00 ET weekdays; skip weekends/holidays and if run within **6h**.

- **Fitness (1× daily, morning)**
  - Check Whoop recovery and whether a workout is scheduled.
  - Skip if already briefed today.

- **Weather (1× daily, morning)**
  - Warren, NJ forecast; flag rain or extreme temps.

- **API budget (every 4h on weekdays, business hours)**
  - Run `tools/budget/anthropic-monitor.sh` (Opus-priced estimate from today's Anthropic sessions).
  - Trigger times: 9:00 AM, 1:00 PM, 5:00 PM ET (Mon–Fri).
  - Alert if remaining Anthropic credits `< $20`.
  - Alert if projected burn rate `> $25/day`.
  - Include top spend sessions + one mitigation action in alert.

- **Tech news on critical tools (2× daily, afternoon + evening)**
  - Quick scan: OpenClaw, Anthropic, OpenAI, core infra via TechCrunch, HN, web search.
  - Alert on acquisitions, shutdowns, major security issues, breaking changes.
  - Skip if run within **4h**.

- **Mission advancement (1× daily, evening)**
  - Reverse-prompt a concrete task that advances Time/Health/Wealth/Career.
  - Auto-executable → add to `cortana_tasks`.
  - Needs approval → surface to Hamel at next check-in.
  - Skip if already proposed a mission task today.

- **Unified memory ingestion (1–2× daily)**
  - Run `npx tsx tools/memory/ingest_unified_memory.ts --since-hours 24`.
  - Skip if run in last **12h** and no major new events.

- **Memory compaction (1× daily)**
  - Run `~/openclaw/tools/memory/compact-memory.sh`.
  - Archive daily notes older than 7 days; generate dedup/staleness findings for `MEMORY.md`; enforce size thresholds.
  - Skip if run in last **24h**.

- **Reflection sweep (1× daily, evening)**
  - Run `npx tsx tools/reflection/reflect.ts --mode sweep --trigger-source heartbeat --window-days 30`.
  - If repeated correction rate >25% → alert Hamel and propose stronger rules.
  - Skip if run in last **12h**.
  - If `cortana_feedback` corrections not synced to `mc_feedback_items`, run:
    ```bash
    npx tsx ~/openclaw/tools/feedback/sync-feedback.ts
    ```

- **Feedback triage (every heartbeat)**
  - Run `~/openclaw/tools/feedback/feedback-to-tasks.sh` to push verified/new corrections into `cortana_tasks`.

- **Feedback pipeline reconciliation (every heartbeat)**
  - Run `~/openclaw/tools/feedback/pipeline-reconciliation.sh`.
  - Checks flow: `cortana_feedback` → `mc_feedback_items` → `cortana_tasks`.
  - Logs `feedback_pipeline_reconciliation` events for drift/stuck stages.

- **Feedback logging during conversation (on new correction)**
  - Immediately log:
    ```bash
    ~/openclaw/tools/feedback/log-feedback.sh "correction" "<severity>" "<summary>" '{"context":"...","lesson":"..."}' "<agent_id>"
    ```
  - Severity:
    - Contains "HARD RULE" / "MANDATORY" / "ZERO TOLERANCE" → `high`
    - Repeated lesson → `high`
    - Normal correction → `medium`
    - Preference/style → `low`
  - If fix is known, add remediation action:
    ```bash
    ~/openclaw/tools/feedback/add-feedback-action.sh "<feedback_id>" "prompt_patch" "<description of fix>" "<commit_hash>" "applied"
    ```

- **Active commitments recovery (every heartbeat)**
  - Run `tools/decisions/heartbeat-check-commitments.sh`.
  - Also check `## Active Commitments` section in MEMORY.md.
  - If pending financial decisions exist and are unresolved → alert Hamel immediately.
  - If any decision is past `expires_at` → mark expired and alert.
  - Auto-resolve decisions that have been completed (cross-reference with task board).

- **Task board hygiene (every heartbeat)**
  - Sweep `cortana_tasks` for ghosts/stale entries:
    - Work complete but tasks still `in_progress`/`ready` → mark `completed` with outcome.
    - `in_progress` tasks with no active sub-agent and 2h+ inactivity → resolve (complete/fail/return to `ready`).
    - Tasks tied to completed epics but still open → close.
    - Duplicate tasks → cancel newer one.
  - Goal: Chief never sees stale dashboard state.

- **Task detection + queue execution (every heartbeat)**
  - Scan recent conversation for high-confidence actionable items (see `projects/task-board-detection.md`).
  - Auto-create only high-confidence standalone tasks.
  - "Do all tasks" = `status='ready'` only; never auto-execute `backlog` tasks.
  - Promote `scheduled` → `ready` when `execute_at <= NOW()`.
  - Dispatch dependency-ready, auto-executable tasks via `tools/task-board/auto-executor.sh` (one safe command per heartbeat).
  - Surface overdue `remind_at` tasks and approaching deadlines.

- **Spawn guardrail check (every heartbeat)**
  - Run `npx tsx ~/openclaw/tools/guardrails/detect-cli-spawns.ts`.
  - Detects direct CLI agent spawning that bypasses `sessions_spawn`.
  - Auto-logs violations to `cortana_immune_incidents` and `cortana_feedback`.
  - Alert Hamel on repeat violations.

- **Cron delivery monitoring (every heartbeat)**
  - Run `tools/alerting/check-cron-delivery.sh` every heartbeat.

- **Cron auto-retry (every heartbeat)** — after the cron delivery monitoring check, run `tools/alerting/cron-auto-retry.sh`. Auto-retries any cron with 1+ consecutive failures. Silent on success; alerts Hamel only if retry also fails (2+ consecutive).

- **Sub-agent reaper (every heartbeat)**
  - Run `~/openclaw/tools/reaper/reaper.sh` to clean stale sub-agent sessions.
  - Reaps sessions stuck in "running" for >2h with no activity.
  - Updates `~/.openclaw/subagents/runs.json` and syncs `cortana_tasks` back to `ready`.
  - Logs reaped sessions to `cortana_events` (event_type `subagent_reaped`).
  - Skip if tool doesn't exist yet (graceful degradation).

- **QA system validation (1× daily, morning)**
  - Run `~/openclaw/tools/qa/validate-system.sh --json`.
  - Checks: symlink integrity, cron definitions, DB connectivity, critical tools, heartbeat state, memory files, disk space.
  - On failures: attempt `--fix` for auto-remediable issues (broken symlinks, etc.).
  - Alert Hamel only on unfixable failures.
  - Skip if run within last **24h**.

- **Sub-agent health monitoring (every heartbeat)**
  - Run:
    ```bash
    ~/openclaw/tools/subagent-watchdog/check-subagents.sh
    ```
  - Emits JSON and logs failures to `cortana_events` (`event_type='subagent_failure'`, severity `warning`).
  - If failures/timeouts:
    1. Retry retriable tasks once.
    2. If same session/reason persists across heartbeats → alert Hamel.
    3. Sync affected task-board items (mark failed/cancelled or reschedule) so board matches reality.

## Task Lifecycle

States: `backlog` → `ready` → `in_progress` → `completed`/`failed`/`cancelled` (plus `scheduled` for future `execute_at`).

- "Do all tasks" = `status='ready'` only.
- Auto-executor runs tasks where `status='ready' AND auto_executable=TRUE`.
- Never execute `backlog` or future `scheduled` tasks early.

## Proactive Intelligence (every heartbeat)

- Run cron preflight where relevant:
  ```bash
  tools/alerting/cron-preflight.sh <cron_name> <checks...>
  ```
  - Quarantine failing crons via `~/.openclaw/cron/quarantine/*.quarantined`.
- Run proactive watchlist scan (SQL templates in `docs/heartbeat-sql-reference.md`) to:
  - Auto-heal small issues (trim oversized session files, flag cron runtime regressions).
  - Log outcomes to `cortana_events`.
- Log behavioral patterns to `cortana_patterns` using templates in `docs/heartbeat-sql-reference.md`.
- Run:
  ```bash
  npx tsx tools/proactive/detect.ts --min-confidence 0.66
  ```
  or
  ```bash
  npx tsx tools/proactive/detect.ts --min-confidence 0.72 --create-tasks
  ```
  for gated morning brief task creation.

## Decision Trace Logging (every heartbeat)

After each check, log a decision trace so Mission Control reflects what ran and why.

- Preferred wrapper:
  ```bash
  ~/openclaw/tools/log-heartbeat-decision.sh <check_name> <success|skipped|fail> "<reasoning>" <0.0-1.0> '{"optional":"inputs"}'
  ```
- Under the hood:
  ```bash
  npx tsx ~/openclaw/tools/tracing/log_decision.ts \
    --trigger heartbeat \
    --action-type <check_type> \
    --action-name <specific_check> \
    --outcome <success|skipped|fail> \
    --reasoning "<why taken or skipped>" \
    --confidence <0.0-1.0>
  ```
- At minimum, log traces for:
  - Each rotated check decision (run vs skip)
  - Proactive watchlist scan outcome
  - Task queue execution decision
  - Cron delivery monitor outcome

## Rules

1. Validate state each heartbeat: `~/openclaw/tools/heartbeat/validate-heartbeat-state.sh`.
2. Read/update `memory/heartbeat-state.json` on every heartbeat. **Always set `lastHeartbeat` to the current epoch-ms timestamp** (`Date.now()`) at the start of every run so Mission Control tracks freshness.
3. Run the stalest 1–2 checks from the rotation.
4. Always run proactive watchlist scan and task detection/queue execution.
5. If nothing urgent → reply `HEARTBEAT_OK`.
6. If something needs attention → alert with concise context; auto-heal silently when safe.
7. Run Anthropic budget guard every 4h during business hours; alert when remaining credits < $20 or projected burn > $25/day.
8. Enforce spend controls:
   - Heavy sessions (>120k total tokens) should be compacted/reset and moved off Opus where possible.
   - Sub-agent tasks must set explicit `timeoutSeconds` (default 90s, max 300s unless justified).
   - Dashboard/chat polling should be rate-limited (no rapid loops; minimum 30s cadence per client).
9. Cron delivery failures are P1 — never ignore `lastDelivered: false`.
10. **Channel routing (MANDATORY):** The heartbeat session runs on an internal `heartbeat` messageChannel — this is NOT a real delivery channel. When sending alerts via the `message` tool, you MUST explicitly set `channel: "telegram"` and `target: "8171372724"`. Never omit the channel or it will fail with "Unknown channel: heartbeat".

## Quiet Hours

- **23:00–06:00 ET:** default to `HEARTBEAT_OK` unless truly urgent.
- Respect sleep schedule (bedtime ~21:00–21:30 ET).
- Auto-heal actions may still run silently during quiet hours.
