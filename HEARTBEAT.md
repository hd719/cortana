# HEARTBEAT.md - Main Heartbeat Contract

Heartbeat goal: stay useful without turning `main` into a noisy workbench.

Healthy path:
- If the heartbeat poll is the only pending message and nothing needs attention, reply exactly `HEARTBEAT_OK`.
- If a newer queued/direct user message is present, answer the user request instead; do not send standalone `HEARTBEAT_OK`.
- Delegated healthy/no-action checks should reply `NO_REPLY` in-session and should not send Telegram.

## Operating Model

1. Validate/update `memory/heartbeat-state.json`.
2. Select at most 1-2 stale checks.
3. Keep local work lightweight: state reads, calendar lookahead, fitness quick check, synthesis.
4. Dispatch heavier checks to owner lanes with `sessions_send`.
5. Stay silent unless there is actionable escalation.

Mandatory state validation:

```bash
npx tsx /Users/hd/Developer/cortana/tools/heartbeat/validate-heartbeat-state.ts
```

## Routing

- Monitor: system health, drift, cron/session reliability, repo sync, inbox/email ops, operational maintenance alerts, trading alert scan ownership.
- Oracle: market/portfolio pulse and X sentiment during market hours.
- Researcher: research/news gathering when explicitly needed.
- Huragok: code/infra/tooling maintenance when explicitly requested.
- Cortana local: state validation, quick calendar/fitness reads, escalation synthesis.

Current Monitor heartbeat entrypoints:
- tech/news scan: `tools/news/tech-news-check.ts`
- inbox-operational scan: `tools/email/inbox_to_execution.ts --output-json`

Do not invent or call deprecated heartbeat wrappers.

Routine maintenance checks already covered by cron should not be re-dispatched on normal heartbeats unless stale/failing:
- task-board hygiene
- feedback reconciliation
- session size guard
- cron delivery monitoring
- subagent watchdog

## Cadence

- Email triage: Monitor-owned, skip if checked within 4h.
- Calendar lookahead: local, skip if checked within 6h.
- Market/portfolio and X sentiment: Oracle, weekdays 9:30 AM-4:00 PM ET, skip if checked within 6h.
- Fitness: local, once daily in the morning.
- Strategic tech/news scan: Monitor, skip if checked within 4h.
- System health/drift: full validation daily; lightweight checks only when stale/failing.
- Repo sync checks: twice daily.

## Dispatch Contract

Every delegated heartbeat task must say:
- run only the requested check
- send actionable results directly to Hamel on Telegram (`channel: telegram`, `target: 8171372724`)
- if healthy/no-action, do not send a Telegram message; Reply exactly `NO_REPLY` in-session only
- if broken, send the failing step, root cause, and immediate next action
- do not send the result back through Cortana unless explicitly asked
- pure announce handoffs such as `Agent-to-agent announce step.` should return `ANNOUNCE_SKIP`

Operational cron/maintenance alerts and inbox/email summaries are user-facing Monitor outputs even when another specialist executes the underlying work.

## Escalation

Alert Hamel only when:
- P0/P1 failure is active
- delivery/gateway/channel reliability is broken
- a delegated check fails repeatedly
- a critical check is stale and dispatch fails
- a prior alert materially changed state

Quiet hours: 11:00 PM-6:00 AM ET. Stay silent unless urgent.
