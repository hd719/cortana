# TOOLS.md – Local Runtime Notes

Environment-specific config and paths.

## Browser (OpenClaw)

- Chrome instance with CDP
- Port: **18800**
- Profile: `~/.openclaw/browser/openclaw/user-data`
- Use `browser` tool with `profile="openclaw"`.
- Direct CDP: `curl http://127.0.0.1:18800/json`
- New tab: `curl -X PUT "http://127.0.0.1:18800/json/new?<URL>"`
- Legacy chrome-debug (9222) is retired.

## Full Disk Access

- OpenClaw/Node has macOS Full Disk Access → can read Downloads, Desktop, Documents, and other TCC-protected folders.

## gog (Gmail / Google Calendar CLI)

- Credentials: `~/Library/Application Support/gogcli/credentials.json`
- Keyring: macOS Keychain (`gog auth keyring keychain`)
- Default calendar: **"Clawdbot-Calendar"** (primary is empty)

Example:
```bash
gog cal list "Clawdbot-Calendar" --from today --plain
```

## Watchdog (LaunchAgent)

- Service: `com.cortana.watchdog`
- Script: `~/Developer/cortana-external/watchdog/watchdog.sh`
- Schedule: every 15 minutes via launchd; auto-start on boot
- Checks: PostgreSQL, fitness service, OpenClaw gateway, disk space

## iCloud Drive

- Path: `~/Library/Mobile Documents/com~apple~CloudDocs/`
- Rules:
  - ✅ READ files
  - ✅ COPY/MOVE files **into** iCloud
  - ❌ Never move files **out of** iCloud
  - ❌ Never delete from iCloud

## Cortana Database (PostgreSQL)

- DB: `cortana` (PostgreSQL 17 local)
- Binaries: `/opt/homebrew/opt/postgresql@17/bin`
- Service: `brew services start/stop postgresql@17`

### Tables (summary)

- **cortana_events** – error/system events (id, timestamp, event_type, source, severity, message, metadata JSONB)
- **cortana_patterns** – routine/behavior patterns (id, timestamp, pattern_type, value, day_of_week, metadata JSONB)
- **cortana_upgrades** – self-improvement proposals (id, proposed_at, gap_identified, proposed_fix, effort, status, outcome, approved_at, implemented_at)
- **cortana_feedback** – corrections/preferences (id, timestamp, feedback_type, context, lesson, applied)
- **cortana_self_model** – self-health singleton (id=1, health_score, status, budget_* fields, throttle_tier, cron/tool stats, alerts, metadata, updated_at)
- **cortana_budget_log** – budget history (id, timestamp, spend_to_date, burn_rate, projected, breakdown JSONB, pct_used)
- **cortana_cron_health** – cron health history (id, timestamp, cron_name, status, consecutive_failures, run_duration_sec, metadata)
- **cortana_tool_health** – tool availability history (id, timestamp, tool_name, status, response_ms, error, self_healed)
- **cortana_throttle_log** – throttle tier changes (id, timestamp, tier_from, tier_to, reason, actions_taken[])
- **cortana_immune_incidents** – immune incidents (id, detected_at, resolved_at, threat_type, source, severity, description, threat_signature, tier, status, playbook_used, resolution, auto_resolved, metadata)
- **cortana_immune_playbooks** – immune playbooks (id, name, threat_signature, description, actions JSONB, tier, enabled, times_used, last_used, success_rate, created_at, updated_at)
- **cortana_tasks** – autonomous task queue (id, created_at, source, title, description, priority 1–5, status, due_at, remind_at, execute_at, auto_executable, execution_plan, depends_on, completed_at, outcome, metadata, epic_id, parent_id, assigned_to)
- **cortana_epics** – task epics/projects (id, title, source, status, deadline, created_at, completed_at, metadata)

### Quick Commands

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

# Recent events
psql cortana -c "SELECT * FROM cortana_events ORDER BY timestamp DESC LIMIT 10;"

# Upgrade history
psql cortana -c "SELECT proposed_at::date, gap_identified, status FROM cortana_upgrades ORDER BY proposed_at DESC;"

# Patterns by day
psql cortana -c "SELECT pattern_type, day_of_week, COUNT(*) FROM cortana_patterns GROUP BY pattern_type, day_of_week;"

# Unprocessed feedback
psql cortana -c "SELECT * FROM cortana_feedback WHERE applied = FALSE;"
```

## OpenClaw Update Procedure

After `npm update -g openclaw`:
1. `bash ~/openclaw/tools/openclaw/post-update.sh`
2. Verify: `openclaw status | grep "app"` (CLI and gateway versions must match)

Post-update script handles:
- Syncing `~/.openclaw/cron/jobs.json` ↔ `/Users/hd/openclaw/config/cron/jobs.json` (copy runtime → repo when content differs, then restore symlink)
- `openclaw gateway install --force`
- `cd /opt/homebrew/lib/node_modules/openclaw && pnpm add @lancedb/lancedb`
- `openclaw gateway restart`

## Symlinks (Repo → Runtime)

- `~/.openclaw/cron/jobs.json` → `/Users/hd/openclaw/config/cron/jobs.json`
- Any new repo↔runtime symlink must be added here.

## Weather

- Primary: `wttr.in`
- Fallback (Warren, NJ):

```bash
curl -s "https://api.open-meteo.com/v1/forecast?latitude=40.63&longitude=-74.49&current_weather=true&temperature_unit=fahrenheit&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=America/New_York&forecast_days=3"
```

See `skills/weather/SKILL.md` for details and code reference.

## Market Intelligence Tool

- Script: `~/openclaw/tools/market-intel/market-intel.sh`
- README: `~/openclaw/tools/market-intel/README.md`

Usage:
```bash
~/openclaw/tools/market-intel/market-intel.sh --ticker NVDA
~/openclaw/tools/market-intel/market-intel.sh --portfolio
~/openclaw/tools/market-intel/market-intel.sh --pulse
```

Notes:
- Uses `skills/stock-analysis` for quotes
- Uses `bird` for X sentiment/key account flow
- Uses `skills/markets` for market status
- Uses Alpaca local endpoint `http://localhost:3033/alpaca/portfolio` for positions

## Skill-Specific Config

- Fitness (Whoop/Tonal) → `fitness-coach` skill
- Calendar (khal/vdirsyncer) → `caldav-calendar` skill
- Gmail/Google Calendar (gog) → `gog` skill
