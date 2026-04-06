# Morning Brief Orchestration

## Live path
- Script: `tools/morning-brief/orchestrate-brief.ts`
- Wrapper: `tools/morning-brief/run-morning-brief.sh`
- Cron job: `☀️ Morning brief (Hamel)`
- Job id: `489b1e20-1bb0-48e6-a388-c3cc1743a324`

## Source of truth
The live Morning Brief now comes from the deterministic wrapper path, not a freeform cron prompt.

The script gathers:
- Google Calendar schedule for today
- open Apple Reminders from the `Cortana` list
- Warren, NJ weather
- concise news from `researcher`
- concise market snapshot from `oracle`

The script sends Telegram itself and supports `--dry-run` for local validation.
