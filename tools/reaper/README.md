# Sub-agent Reaper

Cleans up stale sub-agent runs that are stuck in `running`/`in_progress` with no active session.

## What it does

`reaper.py`:

1. Reads `~/.openclaw/subagents/runs.json` (or `OPENCLAW_SUBAGENT_RUNS_PATH`).
2. Finds runs with `status` in `running`/`in_progress` and `startedAt` older than `--max-age-hours` (default 2h).
3. Checks active sessions via `openclaw sessions --json --all-agents --active` and matches by `childSessionKey`, `runId`, or `sessionId`.
4. If no active session exists, it:
   - marks the run failed in `runs.json` (`endedReason=reaped_stale`, `endedAt=now`, `outcome.status=failed`)
   - logs `cortana_events` with `event_type='subagent_reaped'`, `source='subagent-reaper'`, `severity='warning'`
   - resets matching `cortana_tasks` from `in_progress` back to `ready` with an outcome note

## Files

- `reaper.py` — reaper logic + DB updates
- `reaper.sh` — shell wrapper (heartbeat validation + python entrypoint)

## Usage

```bash
# Default: reaps runs older than 2 hours
~/Developer/cortana/tools/reaper/reaper.sh

# Custom age threshold (4 hours)
~/Developer/cortana/tools/reaper/reaper.sh --max-age-hours 4

# Dry run (no file/DB writes)
~/Developer/cortana/tools/reaper/reaper.sh --dry-run

# Emit JSON summary
~/Developer/cortana/tools/reaper/reaper.sh --emit-json
```

## Output shape (when --emit-json)

```json
{
  "ok": true,
  "summary": {
    "runsScanned": 12,
    "staleCandidates": 2,
    "reapedRuns": 1,
    "eventsLogged": 1,
    "tasksReset": 1,
    "errors": 0
  },
  "reaped": [
    {
      "runKey": "...",
      "runId": "...",
      "childSessionKey": "...",
      "label": "huragok-...",
      "ageHours": 3.2,
      "endedAt": "2026-02-28T15:22:09+00:00",
      "eventLogged": true,
      "tasksReset": 1
    }
  ]
}
```
