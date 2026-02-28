# Sub-agent Watchdog

Closes the visibility gap where a sub-agent can fail/timeout silently unless manually checked.

## What it does

`check-subagents.sh` (wrapper) runs `check-subagents.py`, which:

1. Calls `openclaw sessions --json --all-agents --active <minutes>`
2. Filters sub-agent sessions (`key` contains `:subagent:`)
3. Flags sessions when any of these are true:
   - `abortedLastRun: true`
   - Runtime exceeds configured max (default 5 minutes) for likely in-flight sessions
   - Session has an explicit failed status (if `status`/`lastStatus` is present and in failed/error/timeout/cancelled)
4. Logs each finding to `cortana_events` as:
   - `event_type='subagent_failure'`
   - `source='subagent-watchdog'`
   - `severity='warning'`
   - `metadata` includes session key, label, runtime, reason, session id
5. Sends Telegram failure alerts via `tools/notifications/telegram-delivery-guard.sh` with `alert_type=subagent_failure_alert`.
6. Runs `tools/task-board/completion-sync.sh` to auto-sync mapped in-progress tasks to `done`/`failed`.
7. Prints structured JSON summary to stdout so heartbeat/cron can react.
8. Wrapper post-step: runs `tools/reaper/reaper.sh` to clean stale sub-agent runs (best-effort).

## Files

- `check-subagents.sh` — shell entrypoint
- `check-subagents.py` — detection + DB logging + JSON output

## Usage

```bash
# Default: 5 min timeout, scan last 24h, de-dupe logs for 6h
~/openclaw/tools/subagent-watchdog/check-subagents.sh

# Custom timeout (10 min)
~/openclaw/tools/subagent-watchdog/check-subagents.sh --max-runtime-seconds 600

# Scan only last 4 hours
~/openclaw/tools/subagent-watchdog/check-subagents.sh --active-minutes 240

# Reaper standalone (stale runs >2h)
~/openclaw/tools/reaper/reaper.sh --max-age-hours 2
```

## Output shape

```json
{
  "ok": true,
  "summary": {
    "sessionsScanned": 79,
    "subagentSessionsScanned": 16,
    "failedOrTimedOut": 3,
    "loggedEvents": 2,
    "logErrors": 0
  },
  "failedAgents": [
    {
      "key": "agent:main:subagent:...",
      "label": "huragok-...",
      "runtimeSeconds": 812,
      "reasonCode": "aborted_last_run",
      "reasonDetail": "abortedLastRun=true",
      "logged": true,
      "cooldownSkipped": false
    }
  ]
}
```

## De-dup behavior

The script stores watchdog state in `~/openclaw/memory/heartbeat-state.json` under `subagentWatchdog`:

- `lastRun` timestamp
- `lastLogged` map (`<session_key>|<reason>` => timestamp)

Default cooldown is 6 hours (`--cooldown-seconds 21600`) to avoid spamming `cortana_events` every heartbeat for the same failure.

## Heartbeat integration pattern

Run once per heartbeat and branch on JSON:

- `failedOrTimedOut == 0` → no action
- retriable tasks (timeouts/transient failures) → retry once
- persistent failures across heartbeats → alert Hamel
- sync task board status for affected delegated work (built in via `completion-sync.sh`)

### Task board auto-sync mapping

`tools/task-board/completion-sync.sh` maps completed/failed sub-agent sessions to `cortana_tasks` rows by:
- `assigned_to = <subagent label>`
- `assigned_to = <session key>`
- `metadata.subagent_label` or `metadata.subagent_session_key`

Recommended heartbeat hook order:
1. run `check-subagents.sh`
2. consume JSON summary (`failedOrTimedOut`, `alertsSent`, `taskBoardSync`)
3. branch retry/escalation logic from one payload
