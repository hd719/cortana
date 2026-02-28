# meta-monitor

Monitors the monitors.

`meta-monitor.sh` inspects proprioception health tables to catch failures in the monitoring pipeline itself:

- `cortana_cron_health`: alerts on **2+ consecutive failures** for any cron (from the latest `LAST_N` runs, default `10`)
- `cortana_tool_health`: alerts when a tool has stayed unhealthy for **>1 hour** continuously
- local meta-monitor state: tracks last-run timestamp and flags if this monitor itself is stale

## Usage

```bash
/Users/hd/openclaw/tools/meta-monitor/meta-monitor.sh
/Users/hd/openclaw/tools/meta-monitor/meta-monitor.sh --brief
/Users/hd/openclaw/tools/meta-monitor/meta-monitor.sh --json
```

Modes:
- default: full human report with ✅ / ⚠️ / ❌
- `--brief`: one-line status summary
- `--json`: machine-readable payload

## State file

The script writes and reads:

- `tools/meta-monitor/state/last_run_epoch`

Behavior:
- reads previous run timestamp to evaluate staleness
- writes current run timestamp at end of successful execution

## Configuration (env vars)

- `PSQL_BIN` (default `/opt/homebrew/opt/postgresql@17/bin/psql`)
- `DB_NAME` (default `cortana`)
- `LAST_N` (default `10`)
- `DOWN_THRESHOLD_SECONDS` (default `3600`)
- `META_STALE_SECONDS` (default `28800`, 8h)

## Cron scheduling

This tool is designed for 6-hour cadence and is registered in `config/cron/jobs.json` as:

- `0 */6 * * *` (America/New_York)
