# Precompute Oracle: 6AM Answers Before Questions Exist

## Objective
Precompute likely morning asks at **5:30 AM ET** so the 6 AM brief can answer instantly from local cache.

Implemented for task **#116**.

---

## Pattern Analysis (Data-Driven)

### `cortana_patterns` findings
Querying `cortana_patterns` shows a strong morning cadence:

- `wake` events logged daily from `morning_brief_cron`
- wake-time values shifted from `07:00` to `07:30` recently
- recurring daily execution behavior confirms a stable morning briefing loop

This indicates the system should have data ready before wake/brief windows.

### `MEMORY.md` findings
Recurring explicit morning intents:

- "Be predictive when Hamel wakes up"
- Surface: **recovery, weather, calendar, open items/upcoming events**
- Existing portfolio/trading context and email triage automation make **portfolio + inbox highlights** recurring morning asks

### Recurring morning question set
Based on both sources, precompute now targets:

1. Weather
2. Calendar
3. Portfolio snapshot
4. Fitness recovery
5. Email highlights

---

## Implementation

### Script
- Path: `~/Developer/cortana/tools/oracle/precompute.ts`
- Command modes:
  - `npx tsx ~/Developer/cortana/tools/oracle/precompute.ts run`
  - `npx tsx ~/Developer/cortana/tools/oracle/precompute.ts status`
  - `npx tsx ~/Developer/cortana/tools/oracle/precompute.ts read`
  - `npx tsx ~/Developer/cortana/tools/oracle/precompute.ts read <weather|calendar|portfolio|recovery|email>`

### Cache
- Path: `~/Developer/cortana/tmp/oracle-cache.json`
- Format:
  - `generated_at`, `expires_at`, `ttl_seconds`
  - `sources.<name>.{ok,fetched_at,expires_at,ttl_seconds,data,error}`

### TTL policy
- weather: 3h
- calendar: 90m
- portfolio: 45m
- recovery: 90m
- email: 30m
- Global cache expiry = earliest source expiry

### Data fetch strategy (with fallback)
- **Weather**: wttr.in JSON → Open-Meteo fallback
- **Calendar**: `gog cal list --days 1 --plain`
- **Portfolio**:
  - preferred: Alpaca API (`ALPACA_API_KEY`/`ALPACA_API_SECRET` or APCA variants)
  - fallback: latest portfolio-related task metadata from `cortana_tasks`
- **Recovery**: probes local endpoints on `localhost:3033` (`whoop/fitness/tonal` variants)
- **Email**: `gog gmail search` unread-focused query with normalization

---

## launchd Schedule (5:30 AM daily)

### Plist files
- Source-managed copy: `~/Developer/cortana/config/launchd/com.cortana.oracle-precompute.plist`
- Installed copy: `~/Library/LaunchAgents/com.cortana.oracle-precompute.plist`

### Schedule
- `StartCalendarInterval`: Hour `5`, Minute `30`
- Runs: `npx tsx /Users/hd/Developer/cortana/tools/oracle/precompute.ts run`

### Load / reload commands
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cortana.oracle-precompute.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cortana.oracle-precompute.plist
launchctl enable gui/$(id -u)/com.cortana.oracle-precompute
```

### Verify
```bash
npx tsx ~/Developer/cortana/tools/oracle/precompute.ts run
npx tsx ~/Developer/cortana/tools/oracle/precompute.ts status
npx tsx ~/Developer/cortana/tools/oracle/precompute.ts read weather
```

---

## Morning Brief Consumption

The brief can read the cache directly and avoid live API/tool latency:

```bash
npx tsx ~/Developer/cortana/tools/oracle/precompute.ts read --allow-stale
npx tsx ~/Developer/cortana/tools/oracle/precompute.ts read weather
npx tsx ~/Developer/cortana/tools/oracle/precompute.ts read calendar
```

Use `--allow-stale` only if fallback display is preferred over hard failure.
