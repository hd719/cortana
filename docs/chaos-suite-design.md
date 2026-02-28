# Reliability Chaos Suite for Cortana Self-Healing

## Objective
Add a safe, repeatable chaos framework that continuously validates Cortana’s self-healing loop and measures MTTR (Mean Time To Recovery) per fault class.

## Scope
- Fault injection (safe simulation only)
- Isolated test harness
- MTTR persistence and scorecards
- Regression probes around chaos run
- Optional scheduled mode
- Strong safety guards to avoid production impact

## Existing self-healing dependencies
- `proprioception/run_health_checks.py`
- `cortana_immune_incidents`, `cortana_immune_playbooks`
- `cortana_tool_health`, `cortana_cron_health`
- external watchdog (`~/Developer/cortana-external/watchdog/`)
- tiered response model: auto-fix → alert/suggest → ask-first

## Architecture

### 1) Chaos Runner (`tools/chaos/runner.py`)
Responsibilities:
- Select scenarios by name (or all)
- Execute baseline regression probe (`run_health_checks.py --dry-run`)
- Run scenario simulations in isolation
- Execute post-chaos regression probe
- Persist run + event telemetry
- Build MTTR scorecard for recent window

### 2) Scenario modules (`tools/chaos/scenarios/*.py`)
Each scenario implements:
- fault injection simulation
- detection timing
- recovery timing
- structured metadata

Implemented scenarios:
- `tool_unavailability`: timeout/service-down simulation with fallback
- `cron_failure`: missed/hung cron simulation + reschedule remediation
- `db_connection_issue`: transient DB outage + retry/reconnect
- `memory_corruption`: invalid state file repaired in temp sandbox
- `heartbeat_miss`: stale heartbeat signal + state refresh

### 3) MTTR tracker (`tools/chaos/mttr.py`)
Responsibilities:
- record run metadata in `cortana_chaos_runs`
- record scenario telemetry in `cortana_chaos_events`
- aggregate scorecards by fault type over time window

### 4) SQL migration (`migrations/011_chaos_suite.sql`)
Adds:
- `cortana_chaos_runs`
- `cortana_chaos_events`
- `cortana_chaos_mttr_scorecard` view

## Safety model
Hard guardrails:
1. **Simulation-only defaults**: no production DB corruption, no service kill operations.
2. **Isolated artifacts**: state-file corruption test writes only under `tempfile` sandbox.
3. **Regression protection**: pre/post dry-run health-check to detect regressions.
4. **Structured status**: run marked failed if recovery or regression fails.
5. **No destructive side effects**: no writes to real cron job state, tool processes, or production tables outside dedicated chaos telemetry.

## MTTR metrics
Per scenario event:
- `detection_ms`
- `recovery_ms`
- `detected`, `recovered`

Scorecard aggregates:
- avg detection ms
- avg recovery ms (MTTR proxy)
- recovery rate %
- last tested timestamp

## Regression test strategy
- Baseline: `python3 proprioception/run_health_checks.py --dry-run`
- Post-chaos: same command
- Failure in either marks chaos run failed

## Scheduled chaos mode
Runner supports `--mode scheduled` for cron-triggered executions.
Suggested cron cadence:
- daily light run (all scenarios)
- weekly expanded run with stricter thresholds and trend analysis

## Usage
```bash
# Apply migration
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana -f /Users/hd/openclaw/migrations/011_chaos_suite.sql

# Run all scenarios + regression checks
python3 /Users/hd/openclaw/tools/chaos/runner.py --json

# Run selected scenarios only
python3 /Users/hd/openclaw/tools/chaos/runner.py --scenarios tool_unavailability heartbeat_miss --json

# Scheduled mode
python3 /Users/hd/openclaw/tools/chaos/runner.py --mode scheduled --json
```

## Follow-ups
- Add threshold-based failure policy (e.g., MTTR > SLO)
- Integrate run summary into morning brief/health dashboard
- Add optional active fault-injection adapters for non-prod test envs
