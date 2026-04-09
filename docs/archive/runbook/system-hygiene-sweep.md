# System Hygiene Sweep

`tools/hygiene/sweep.ts` runs a daily hygiene pass for low-risk system cleanup and drift detection.

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
npx tsx tools/hygiene/sweep.ts
# same as:
npx tsx tools/hygiene/sweep.ts audit
```

### Clean (safe mode required)
Low-risk cleanup only:
- delete stale temp/log files
- truncate oversized session logs in place

```bash
npx tsx tools/hygiene/sweep.ts clean --safe
```

Dry-run cleanup:

```bash
npx tsx tools/hygiene/sweep.ts clean --safe --dry-run
```

### Report JSON
Machine-readable output:

```bash
npx tsx tools/hygiene/sweep.ts report --json
```

## Risk scoring
Each finding is categorized (`info` / `warn` / `critical`) and contributes to an aggregate risk score (0-100):

- info = weight 1
- warn = weight 4
- critical = weight 10

## Event logging
Each run inserts one event into `cortana_events`:

- `event_type='system_hygiene'`
- `source='tools/hygiene/sweep.ts'` (wrapper entrypoint; emitted by the TypeScript command)
- `severity=info|warning|critical` (derived from findings)
- `metadata` JSON payload includes findings + risk score

To skip DB logging:

```bash
npx tsx tools/hygiene/sweep.ts audit --no-log-event
```

## launchd schedule
LaunchAgent plist:

- `config/launchd/com.cortana.system-hygiene-sweep.plist`
- Daily at **02:45** local time
- Also runs on load (`RunAtLoad=true`) for out-of-band recovery after reboot/login

Load and start:

```bash
launchctl unload ~/Library/LaunchAgents/com.cortana.system-hygiene-sweep.plist 2>/dev/null || true
cp /Users/hd/Developer/cortana/config/launchd/com.cortana.system-hygiene-sweep.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cortana.system-hygiene-sweep.plist
launchctl start com.cortana.system-hygiene-sweep
```

Check status:

```bash
launchctl list | grep com.cortana.system-hygiene-sweep
```

## Boot-time validation (out-of-band)
LaunchAgent plist:

- `config/launchd/com.cortana.boot-validate-system.plist`
- Runs at load and every 6 hours (`StartInterval=21600`)
- Command: `npx tsx tools/qa/validate-system.ts --json --fix`

Load and start:

```bash
launchctl unload ~/Library/LaunchAgents/com.cortana.boot-validate-system.plist 2>/dev/null || true
cp /Users/hd/Developer/cortana/config/launchd/com.cortana.boot-validate-system.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cortana.boot-validate-system.plist
launchctl start com.cortana.boot-validate-system
```
