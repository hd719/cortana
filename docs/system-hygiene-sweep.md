# System Hygiene Sweep

`tools/hygiene/sweep.py` runs a daily hygiene pass for low-risk system cleanup and drift detection.

## What it checks

1. **Orphaned/stale subagent sessions**
   - Reads `openclaw subagents list --json`
   - Flags active sessions older than `--stale-session-minutes` (default: 180)
   - Flags recent `failed` / `timeout` sessions as warning signals

2. **Stale temp/log files**
   - Scans `tmp/`, `logs/`, `cortical-loop/logs/` by default
   - Finds files older than `--stale-file-days` (default: 7)

3. **Migration drift**
   - Scans `migrations/*.sql`
   - Flags duplicate numeric migration prefixes (e.g. `012_*.sql` collisions)

4. **Oversized session logs**
   - Detects `*.log` files with names containing `session`, `subagent`, or `agent`
   - Threshold via `--oversized-log-mb` (default: 25)

## Commands

### Audit (default)
Detect only:

```bash
python3 tools/hygiene/sweep.py
# same as:
python3 tools/hygiene/sweep.py audit
```

### Clean (safe mode required)
Low-risk cleanup only:
- delete stale temp/log files
- truncate oversized session logs in place

```bash
python3 tools/hygiene/sweep.py clean --safe
```

Dry-run cleanup:

```bash
python3 tools/hygiene/sweep.py clean --safe --dry-run
```

### Report JSON
Machine-readable output:

```bash
python3 tools/hygiene/sweep.py report --json
```

## Risk scoring
Each finding is categorized (`info` / `warn` / `critical`) and contributes to an aggregate risk score (0-100):

- info = weight 1
- warn = weight 4
- critical = weight 10

## Event logging
Each run inserts one event into `cortana_events`:

- `event_type='system_hygiene'`
- `source='tools/hygiene/sweep.py'`
- `severity=info|warning|critical` (derived from findings)
- `metadata` JSON payload includes findings + risk score

To skip DB logging:

```bash
python3 tools/hygiene/sweep.py audit --no-log-event
```

## launchd schedule
LaunchAgent plist:

- `config/launchd/com.cortana.system-hygiene-sweep.plist`
- Daily at **02:45** local time

Load and start:

```bash
launchctl unload ~/Library/LaunchAgents/com.cortana.system-hygiene-sweep.plist 2>/dev/null || true
cp /Users/hd/openclaw/config/launchd/com.cortana.system-hygiene-sweep.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cortana.system-hygiene-sweep.plist
launchctl start com.cortana.system-hygiene-sweep
```

Check status:

```bash
launchctl list | grep com.cortana.system-hygiene-sweep
```
