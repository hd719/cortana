# Alerting Tooling

Scripts under `tools/alerting/` implement **safety rails and health checks** around cron jobs, cost usage, and Tonal fitness service availability.

## Purpose

Provide central shell utilities for:

- Preflight checks before cron jobs run (DB, gateway, fitness, Google APIs).
- Monitoring and enforcing budget/cost guardrails for LLM usage.
- Verifying Tonal health endpoints with retries and progress logging.

These tools are used by cron and watchdog jobs to automatically quarantine unhealthy cron entries, trip cost circuit breakers, and surface fitness-service issues.

## Key entrypoints

- `cron-preflight.sh`
  - Quality gate for cron jobs.
  - Usage: `cron-preflight.sh <cron_name> [required_check ...]`.
  - Supported checks: `pg`, `gog`, `gog_oauth`, `fitness`, `gateway`.
  - On failure, writes a quarantine marker under `~/.openclaw/cron/quarantine/<cron_name>.quarantined` and logs to `cortana_events`.

- `cost-breaker.sh`
  - Runaway session cost **circuit breaker**.
  - Reads usage via the `telegram-usage` skill handler, computes spend/burn/projection, and applies thresholds (50% pre‑midmonth warning, 75% critical, runaway subagent token limits).
  - Can optionally attempt to kill a runaway session: `--kill-runaway <sessionKey>`.
  - Emits a JSON summary and, on critical breach, writes `~/.openclaw/cost-alert.flag`, logs to `cortana_events`, and can send a Telegram alert via `tools/notifications/telegram-delivery-guard.sh`.

- `tonal-health-check.sh`
  - Robust health check for the local Tonal service.
  - Hits `http://localhost:3033/tonal/health` (and an optional fallback endpoint) with bounded timeouts and retries.
  - Emits periodic checkpoints so long-running checks don’t go silent.
  - Logs progress and results into `cortana_events`.

## When to use / when NOT to use

**Use these scripts when:**

- Wiring new cron jobs that depend on PostgreSQL, Google APIs (`gog`), the fitness service, or the OpenClaw gateway and you want automatic quarantine behavior.
- Monitoring or enforcing monthly LLM spend and wanting automated alerts/flags when budgets are at risk.
- Building or debugging automation around the Tonal fitness service health.

**Do NOT use these scripts when:**

- You just need a one-off quick health check (e.g., running `psql` or `curl` manually may be simpler).
- You’re operating outside the Cortana/OpenClaw environment (paths, DB, and Telegram guard assumptions won’t hold).
- You need cross‑machine monitoring; these are single‑host, local scripts.

## Dependencies

Common environment assumptions:

- macOS host with Homebrew paths:
  - `/opt/homebrew/bin`, `/opt/homebrew/opt/postgresql@17/bin` in `PATH`.
- PostgreSQL:
  - Database: `cortana` (or overridden via `CORTANA_DB`).
  - `psql` available.
- CLI tools:
  - `gog` (Google Workspace CLI) for calendar/gmail checks.
  - `openclaw` CLI for gateway status and subagent control.
  - `curl`, `timeout`, `jq`, `pgrep`, `bash` with `set -euo pipefail` semantics.
- Node / skills:
  - `node` to run `skills/telegram-usage/handler.js`.
  - `tools/notifications/telegram-delivery-guard.sh` for Telegram alerts.

See `TOOLS.md` for broader environment notes (PostgreSQL path, gog/openclaw setup, and Telegram usage skill) that these alerting scripts rely on.