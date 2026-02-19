# TOOLS.md - Local Notes

Environment-specific config that doesn't belong in skills.

---

## Browser Access (OpenClaw Browser)

OpenClaw manages its own Chrome instance with CDP access.

**Config:**
- Port: 18800
- Profile: `~/.openclaw/browser/openclaw/user-data`

**Usage:**
- Use `browser` tool with `profile="openclaw"`
- Direct CDP: `curl http://127.0.0.1:18800/json`
- Open new tab: `curl -X PUT "http://127.0.0.1:18800/json/new?<URL>"`

**Note:** Legacy chrome-debug (port 9222) retired — all browser automation now uses OpenClaw's browser.

---

## Full Disk Access

OpenClaw/Node has **Full Disk Access** granted (macOS System Settings → Privacy & Security → Full Disk Access). This means access to Downloads, Desktop, Documents, and other TCC-protected folders works without permission errors.

---

## gog (Gmail/GCal CLI)

**OAuth credentials installed:** `gog auth credentials` loaded from Google Cloud Console client_secret JSON → stored at `~/Library/Application Support/gogcli/credentials.json`

**Keyring:** Switched to macOS Keychain (`gog auth keyring keychain`) — no password prompts in headless/cron contexts.

---

## Watchdog (LaunchAgent)

**Service:** `com.cortana.watchdog`
**Script:** `~/Developer/cortana-external/watchdog/watchdog.sh`
**Schedule:** Every 15 minutes via launchd, auto-starts on boot
**Checks:** PostgreSQL, fitness service, OpenClaw gateway, disk space

---

## iCloud Drive

**Path:** `~/Library/Mobile Documents/com~apple~CloudDocs/`

**Rules:**
- ✅ READ files
- ✅ COPY/MOVE files INTO iCloud
- ❌ NEVER move files OUT of iCloud
- ❌ NEVER delete files from iCloud

---

## Cortana Database (PostgreSQL)

**Database:** cortana (PostgreSQL 17 local)
**Path:** `/opt/homebrew/opt/postgresql@17/bin`
**Service:** `brew services start/stop postgresql@17`

### Tables

**cortana_events** — Error/system event logging
- Schema: id, timestamp, event_type, source, severity, message, metadata (JSONB)
- Use for: auth failures, cron errors, system events

**cortana_patterns** — Routine/behavior pattern tracking  
- Schema: id, timestamp, pattern_type, value, day_of_week, metadata (JSONB)
- Use for: wake times, sleep checks, workouts, work hours

**cortana_upgrades** — Self-improvement tracking
- Schema: id, proposed_at, gap_identified, proposed_fix, effort, status, outcome, approved_at, implemented_at
- Status: proposed → approved/rejected → implemented/failed

**cortana_feedback** — Learning from corrections
- Schema: id, timestamp, feedback_type, context, lesson, applied
- Use for: corrections, preferences, approval/rejection reasons

**cortana_self_model** — Proprioception health dashboard (singleton)
- Schema: id (always 1), health_score, status, budget_used/pct/burn_rate/projected, throttle_tier, crons_total/healthy/failing/missed, tools_up/down, top_cost_crons (JSONB), brief_engagement, alerts, metadata (JSONB), updated_at

**cortana_budget_log** — Budget tracking over time
- Schema: id, timestamp, spend_to_date, burn_rate, projected, breakdown (JSONB), pct_used

**cortana_cron_health** — Cron health history
- Schema: id, timestamp, cron_name, status, consecutive_failures, run_duration_sec, metadata (JSONB)

**cortana_tool_health** — Tool availability history
- Schema: id, timestamp, tool_name, status, response_ms, error, self_healed

**cortana_throttle_log** — Auto-throttle tier change events
- Schema: id, timestamp, tier_from, tier_to, reason, actions_taken (TEXT[])

**cortana_immune_incidents** — Immune System incident log
- Schema: id, detected_at, resolved_at, threat_type, source, severity, description, threat_signature, tier, status, playbook_used, resolution, auto_resolved, metadata (JSONB)
- Use for: tracking detected threats, resolutions, quarantines

**cortana_immune_playbooks** — Immune System playbook registry
- Schema: id, name (unique), threat_signature, description, actions (JSONB), tier, enabled, times_used, last_used, success_rate, created_at, updated_at
- Use for: known fix patterns (antibodies)

**cortana_tasks** — Autonomous task queue
- Schema: id, created_at, source, title, description, priority (1-5), status, due_at, remind_at, execute_at, auto_executable, execution_plan, depends_on, completed_at, outcome, metadata (JSONB), epic_id (FK to cortana_epics), parent_id (FK to self), assigned_to (text)
- Use for: tracking work from conversations, heartbeat auto-execution, reminders, epic/subtask hierarchy

**cortana_epics** — Task board epic/project grouping
- Schema: id, title, source, status (active/completed/cancelled), deadline, created_at, completed_at, metadata (JSONB)
- Use for: grouping related tasks into projects/goals with deadlines

### Quick Commands
```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

# View recent events
psql cortana -c "SELECT * FROM cortana_events ORDER BY timestamp DESC LIMIT 10;"

# View upgrade history
psql cortana -c "SELECT proposed_at::date, gap_identified, status FROM cortana_upgrades ORDER BY proposed_at DESC;"

# View patterns by day of week
psql cortana -c "SELECT pattern_type, day_of_week, COUNT(*) FROM cortana_patterns GROUP BY pattern_type, day_of_week;"

# View unprocessed feedback
psql cortana -c "SELECT * FROM cortana_feedback WHERE applied = FALSE;"
```

---

## Weather

**Primary:** `wttr.in` (simple text output)
**Fallback:** Open-Meteo API (free, no key needed) — used when wttr.in is down/slow

```bash
# Fallback URL (Warren NJ)
curl -s "https://api.open-meteo.com/v1/forecast?latitude=40.63&longitude=-74.49&current_weather=true&temperature_unit=fahrenheit&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=America/New_York&forecast_days=3"
```

See `skills/weather/SKILL.md` for full details and weather code reference.

---

## Skill-Specific Config

Most tool configs now live in their skills:
- **Fitness (Whoop/Tonal)** → `fitness-coach` skill
- **Calendar (khal/vdirsyncer)** → `caldav-calendar` skill  
- **Gmail/GCal (gog)** → `gog` skill
