# Event Stream Noise Reduction (Task 276)

## Problem observed
`cortana_events` had heavy info-level noise. In the last 7 days, dominant entries were:
- `watchdog/info`: 3375
- `memory_health/info`: 268

This drowned out warning/error signals in routine event views.

## Implemented solution

### 1) Actionable-events SQL view (warnings+)
Migration: `migrations/022_event_stream_noise_reduction.sql`

Created view:
- `cortana_actionable_events`
- Filters to `severity IN ('warning','error','critical')`
- Adds `severity_rank` for sorting (`critical=4`, `error=3`, `warning=2`, info/default=1)

Use this as the default source for operations dashboards and heartbeat alerting.

### 2) Info-level dedupe rollup view
Same migration creates:
- `cortana_info_event_rollup_15m`

Behavior:
- Buckets events into 15-minute windows
- Groups by identical signature (`source`, `event_type`, `severity`, `message`)
- Keeps only repeated rows (`HAVING count(*) > 1`)

This compresses spammy routine entries like recurring watchdog/memory checks.

### 3) Reporting tool for filtered + aggregated output
Added tool:
- `tools/events/event-noise-report.sh`

Usage:
```bash
/Users/hd/clawd/tools/events/event-noise-report.sh [hours]
# example
/Users/hd/clawd/tools/events/event-noise-report.sh 24
```

Outputs 4 sections:
1. Raw top noise pattern (`event_type/source/severity`)
2. Actionable rollup (warnings+), grouped hourly by signature
3. Info rollup (repeated identical entries in 15m buckets)
4. Subagent failure aggregation (`"N subagent failures in 1h"`)

## Why this design
- Keeps raw event history intact (no destructive cleanup).
- Gives an actionable default (`cortana_actionable_events`) without losing diagnostic detail.
- Adds deterministic aggregation for recurring info and repeated failures.
- Easy to wire into heartbeat/task-board/status views.

## Apply migration
```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana -f /Users/hd/clawd/migrations/022_event_stream_noise_reduction.sql
```
