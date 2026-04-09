# Anomaly Sentinel

`tools/monitoring/anomaly_sentinel.py` detects behavior drift + reliability regressions with low-noise alerting.

## Commands

```bash
python3 tools/monitoring/anomaly_sentinel.py scan --days 7
python3 tools/monitoring/anomaly_sentinel.py report
python3 tools/monitoring/anomaly_sentinel.py report --weekly
python3 tools/monitoring/anomaly_sentinel.py alert --days 14
```

### `scan --days 7|14|30`
Runs anomaly detectors, applies suppression window, and writes unsuppressed anomalies to `cortana_events`:

- `event_type='anomaly_detected'`
- `source='anomaly_sentinel'`
- structured JSON metadata with:
  - `anomaly_class`
  - `fingerprint`
  - metric details (`latest`, `baseline_mean`, `baseline_stddev`, `z_score`, threshold)
  - detector-specific details (`series`, offenders, model breakdown, etc.)

Options:
- `--suppression-hours` (default: `12`)
- `--dry-run` (detect but do not write events)

### `report`
Summarizes recent `anomaly_detected` events from `cortana_events` by class/fingerprint.

Options:
- `--days` (default: `14`)
- `--weekly` forces 7-day weekly summary mode.

### `alert`
Runs a scan and emits only meaningful unsuppressed alerts (writes to `cortana_events`).

## Detected anomaly classes

1. **Repeated task retries / duplicate launches**
   - Signal: per-day duplicate launch groups from `cortana_tasks` (same normalized title/source with >=2 launches/day)
   - Includes top offenders from last 48h.

2. **Rising timeout rate in subagent runs**
   - Signal: timeout ratio from `cortana_event_bus_events` event types:
     - `agent_completed`, `agent_failed`, `agent_timeout`
   - Includes timeout source breakdown (72h).

3. **Cron failure clusters**
   - Signal: repeated failures in `cortana_cron_health` where same cron repeatedly fails (`fail_count`/`consecutive_failures`).
   - Includes top failing cron names from last 72h.

4. **Sudden token burn spikes**
   - Signal: per-day total tokens from `cortana_token_ledger` (`tokens_in + tokens_out`)
   - Includes model-level token/cost breakdown (24h).

## Noise reduction logic

Hybrid trigger (rolling baseline + threshold):
- Compute baseline from prior daily points in selected window.
- Trigger only when:
  - `latest >= hard_threshold`, and
  - (`z_score >= z_threshold` **or** `latest >= baseline_mean * ratio_threshold`)

This avoids firing on tiny deviations while still catching large jumps when variance is low.

## Suppression window

To avoid repeat spam for the same anomaly, the detector suppresses if a matching fingerprint was already emitted recently:

```sql
metadata->>'fingerprint' = <fingerprint>
AND timestamp >= NOW() - INTERVAL '<suppression_hours> hours'
```

Default suppression: `12h`.

## Output

All commands print JSON so they can be consumed by cron, pipelines, or dashboards.
