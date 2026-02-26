# HEARTBEAT.md

Rotating checks for heartbeat polls. Use `memory/heartbeat-state.json` to pick the stalest 1–2 checks.

## Check Rotation

- **Email triage (2–3x daily)** – Run `tools/gmail/email-triage-autopilot.sh` with a minimal query; auto-create tasks for urgent/action emails in `cortana_tasks`; prepare Telegram digest only (no outbound email). Skip if checked within 4 hours.

- **Calendar lookahead (2x daily)** – Scan events in the next 24–48 hours for conflicts or prep. Skip if checked within 6 hours.

- **Portfolio + market (1–2x daily, market hours)** – Use Alpaca service on port **3033** plus `tools/market-intel/market-intel.sh --pulse`. Watch for >3% movers, earnings surprises, and >60% bearish sentiment on held positions. Only 09:30–16:00 ET on weekdays; skip weekends/holidays and if checked within 6 hours.

- **Fitness (1x daily, morning)** – Check Whoop recovery and whether a workout is scheduled. Skip if already briefed today.

- **Weather (1x daily, morning)** – Warren NJ forecast; highlight rain or extreme temps.

- **API budget (weekly or when usage seems high)** – Run `node skills/telegram-usage/handler.js json` for live model usage. If `~/.openclaw/quota-tracker.json` is stale/corrupt (>4h), delete then rerun. Alert if >50% of $100 budget used before day 15; alert with throttling recommendations if >75% at any time.

- **Tech news on critical tools (2x daily, afternoon + evening)** – Quick pass on OpenClaw, Anthropic, OpenAI, and core infra via TechCrunch, HN front page, and web search. Alert on acquisitions, shutdowns, major security issues, or breaking changes. Skip if checked within 4 hours.

- **Mission advancement (1x daily, evening)** – Reverse-prompt for one concrete task that advances Time/Health/Wealth/Career. Auto-executable → add to `cortana_tasks`; needs approval → surface to Hamel next check-in. Skip if already proposed a mission task today.

- **Unified memory ingestion (1–2x daily)** – Run `python3 tools/memory/ingest_unified_memory.py --since-hours 24` to keep episodic/semantic/procedural memory tables fresh. Skip if run in past 12 hours and no major new events.

- **Reflection sweep (1x daily, evening)** – Run `python3 tools/reflection/reflect.py --mode sweep --trigger-source heartbeat --window-days 30`. If repeated correction rate >25% → alert Hamel and propose stronger rule wording. Skip if run in last 12 hours.

When the reflection sweep finds corrections in cortana_feedback that haven't been synced to mc_feedback_items, run:
```bash
python3 ~/clawd/tools/feedback/sync-feedback.py
```

When processing a new correction from the user during conversation, immediately log it:
```bash
~/clawd/tools/feedback/log-feedback.sh "correction" "<severity>" "<summary>" '{"context":"...","lesson":"..."}' "<agent_id>"
```
Severity mapping:
- Contains "HARD RULE" / "MANDATORY" / "ZERO TOLERANCE" → "high"
- Repeated correction (same lesson twice) → "high"
- Normal correction → "medium"
- Preference/style → "low"

After logging feedback, if the fix is known, immediately add a remediation action:
```bash
~/clawd/tools/feedback/add-feedback-action.sh "<feedback_id>" "prompt_patch" "<description of fix>" "<commit_hash>" "applied"
```

- **Task detection + queue execution (every heartbeat)** – Scan recent conversation turns for missed actionable items (see `projects/task-board-detection.md`); auto-create only high-confidence standalone tasks. "Do all pending/ready tasks" means `status='ready'` only. Auto-executor must promote `status='scheduled' AND execute_at <= NOW()` to `ready` before execution. `backlog` tasks are never auto-executed (explicit promotion only). Check `cortana_tasks` for dependency-ready, auto-executable tasks and dispatch via `tools/task-board/auto-executor.sh` (single safe command per heartbeat). Surface overdue `remind_at` tasks and approaching deadlines.

- **Cron delivery monitoring (every heartbeat)** — Parse `~/.openclaw/cron/jobs.json` and check each enabled job with `delivery.mode: "announce"`. If `state.lastStatus == "ok"` but `state.lastDelivered == false` or `state.lastDeliveryStatus != "delivered"`, this is a delivery failure. Alert immediately with the job name and last run time. Log to `cortana_events` with severity 'warning'. Self-heal attempt: if delivery failed, try resending the last result via explicit `message` tool to the configured `delivery.to` target.

## Task Lifecycle

Task Lifecycle:
  backlog → ready → in_progress → completed/failed
  scheduled (execute_at future) → ready (when execute_at <= NOW()) → in_progress → completed/failed

- "Do all tasks" = status='ready' only
- Auto-executor picks up: status='ready' AND auto_executable=TRUE, plus status='scheduled' AND execute_at <= NOW()
- Backlog items require explicit promotion

## Proactive Intelligence (every heartbeat)

- Run cron preflight where relevant: `tools/alerting/cron-preflight.sh <cron_name> <checks...>`; quarantine failing crons via `~/.openclaw/cron/quarantine/*.quarantined`.
- Run a proactive watchlist scan using the SQL templates in `docs/heartbeat-sql-reference.md`; auto-heal silently where possible (e.g., trim oversized session files, flag cron runtime regressions) and log to `cortana_events`.
- Log behavioral patterns to `cortana_patterns` (sequence/time-of-day/recurring combos) using SQL templates in `docs/heartbeat-sql-reference.md`.
- Run `python3 tools/proactive/detect.py --min-confidence 0.66` (or `--min-confidence 0.72 --create-tasks` for gated morning brief) to surface cross-signal opportunities and risks.

## Decision Trace Logging (every heartbeat)

After each heartbeat check, log a decision trace so Mission Control timeline reflects what was checked and what decision was made.

```bash
python3 ~/clawd/tools/tracing/log_decision.py \
  --trigger heartbeat \
  --action-type <check_type> \
  --action-name <specific_check> \
  --outcome <success|skipped|fail> \
  --reasoning "<why this action was taken or skipped>" \
  --confidence <0.0-1.0>
```

Examples:
- Email check → `--action-type email_triage --action-name heartbeat_email_triage --outcome success --reasoning "12 unread, 0 urgent"`
- Skipped check → `--action-type weather_check --action-name heartbeat_weather --outcome skipped --reasoning "checked 2h ago, threshold 6h"`
- Cron delivery alert → `--action-type cron_delivery_monitor --action-name delivery_failure_detected --outcome fail --reasoning "Morning brief ran ok but lastDelivered=false"`
- Task execution → `--action-type task_execution --action-name <task_title> --outcome success`

Preferred wrapper for heartbeat checks:

```bash
~/clawd/tools/log-heartbeat-decision.sh <check_name> <success|skipped|fail> "<reasoning>" <0.0-1.0> '{"optional":"inputs"}'
```

At minimum, log traces for:
- each rotated check decision (run vs skip)
- proactive watchlist scan outcome
- task queue execution decision
- cron delivery monitor outcome

## Rules

1. Read and update `memory/heartbeat-state.json` each heartbeat.
2. Pick the stalest 1–2 checks.
3. Always run the proactive watchlist scan and task detection/queue execution.
4. If nothing urgent is found → reply `HEARTBEAT_OK`.
5. If something needs attention → alert with concise context; auto-heal silently when safe.
6. Raise **budget alerts** if API usage >50% before day 15 or >75% at any time.
7. Cron delivery failures are P1 alerts — never silently ignore `lastDelivered: false`.

## Quiet Hours

- 23:00–06:00 ET: default to `HEARTBEAT_OK` unless truly urgent.
- Respect sleep schedule (bedtime ~21:00–21:30); auto-heal actions may still run silently during quiet hours.
