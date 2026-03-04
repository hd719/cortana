# Sub-agent Reliability Incident Runbook

_Last updated: 2026-03-04_

This runbook is for incidents where sub-agents start aborting/timing out and watchdog alerts re-fire stale failures.

## 1) Symptoms

Look for these signals together:

- `Request was aborted` in sub-agent output/logs
- `runtime_exceeded` in failed runs
- repeated watchdog alerts for old failures (`aborted_last_run` re-flagging)

If all three are present, treat as a reliability incident (not a one-off).

## 2) Likely root causes

Most common causes in this stack:

1. **Concurrency pressure**
   - Effective concurrency too low for active workload.
2. **Oversized/bloated session files**
   - Large `*.jsonl` session artifacts can slow or destabilize runs.
3. **Stale watchdog re-alert noise**
   - Old `abortedLastRun=true` sessions get re-surfaced if not cleaned/archived.
4. **Provider overload vs local config mismatch**
   - Upstream model/provider transient stress vs too-tight local timeout/archive settings.

## 3) Exact diagnostics commands

Run from repo root (`/Users/hd/Developer/cortana`) unless noted.

### A) Session size checks

```bash
# Largest session JSONL files (quick triage)
find ~/.openclaw/agents/main/sessions -name '*.jsonl' -exec du -h {} \; | sort -hr | head -40

# Files above 400 KB threshold
find ~/.openclaw/agents/main/sessions -name '*.jsonl' -size +400k -print
```

### B) Subagent watchdog + event queries

```bash
# Run reliability watchdog with retry policy
/Users/hd/Developer/cortana/tools/subagent-watchdog/check-subagents-with-retry.sh \
  --active-minutes 15 \
  --max-runtime-seconds 900 \
  --cooldown-seconds 900

# Recent subagent failure events from DB
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana -c "
SELECT timestamp, source, severity, message,
       metadata->>'reasonCode' AS reason,
       metadata->>'key' AS session_key
FROM cortana_events
WHERE event_type = 'subagent_failure'
ORDER BY timestamp DESC
LIMIT 50;"

# Current subagent runtime snapshot
openclaw subagents list --json
```

### C) Cron/session cleanup checks

```bash
# Dry-run hygiene scan for stale sessions + oversized logs
npx --yes tsx /Users/hd/Developer/cortana/tools/hygiene/sweep.ts report --json

# Enforce OpenClaw session retention policy
openclaw sessions cleanup --all-agents --enforce --json

# Verify subagent reliability cron wiring
jq '.jobs[] | select(.id | test("subagent-reliability|session-lifecycle|cleanup")) | {id,name,schedule}' \
  /Users/hd/Developer/cortana/config/cron/jobs.json
```

### D) Quick status checks

```bash
openclaw gateway status
openclaw status
openclaw sessions --all-agents --active 60 --json
```

## 4) Remediation steps (ordered)

Perform in order; verify each step before moving to the next.

1. **Cleanup stale sessions first**

```bash
openclaw sessions cleanup --all-agents --enforce --json
```

2. **Remove oversized session files (with caution)**
   - Only remove clear outliers (for example >400 KB) that are stale/non-critical.
   - Never bulk-delete blindly.

```bash
# Example: inspect candidate first
find ~/.openclaw/agents/main/sessions -name '*.jsonl' -size +400k -print

# Example: remove one confirmed stale outlier
rm ~/.openclaw/agents/main/sessions/<stale-session-file>.jsonl
```

3. **Tune key config knobs** (`config/openclaw.json`)

- `agents.defaults.maxConcurrent`
- `agents.defaults.subagents.runTimeoutSeconds`
- `agents.defaults.subagents.archiveAfterMinutes`

Recommended direction for this incident class:
- increase `maxConcurrent` if queue pressure is sustained
- set explicit `runTimeoutSeconds` high enough for normal long-running jobs
- increase `archiveAfterMinutes` to reduce aggressive churn/re-flag loops

4. **Restart/reload runtime after config changes**

```bash
openclaw gateway restart
```

If behavior remains unstable after one full cycle, compare provider health/transient latency versus local timeout/concurrency settings before further increases.

## 5) Verification checklist

A fix is complete only when all checks pass:

- [ ] A manual test sub-agent run completes successfully
- [ ] Watchdog run reports no new actionable failures
- [ ] No new `Request was aborted` / `runtime_exceeded` incidents over next **4 heartbeats**
- [ ] `subagent_failure` events stop re-firing for stale historical sessions

Quick verification commands:

```bash
# Test watchdog after remediation
/Users/hd/Developer/cortana/tools/subagent-watchdog/check-subagents-with-retry.sh --active-minutes 15 --max-runtime-seconds 900 --cooldown-seconds 900

# Confirm no fresh failure spikes
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana -c "
SELECT date_trunc('hour', timestamp) AS hour, COUNT(*) AS failures
FROM cortana_events
WHERE event_type='subagent_failure'
  AND timestamp > NOW() - INTERVAL '6 hours'
GROUP BY 1
ORDER BY 1 DESC;"
```

## 6) Guardrails / security notes

- **Never commit live runtime config snapshots** that may contain secrets/tokens.
- If any token/secret is accidentally committed:
  1. rotate immediately,
  2. revoke old credentials,
  3. scrub history if required by policy,
  4. document incident + remediation in `cortana_events`/ops notes.

When in doubt, treat config artifacts as sensitive until reviewed.
