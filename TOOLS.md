# TOOLS.md - Local Runtime Notes

## Browser

- OpenClaw browser/CDP port: `18800`
- Profile: `~/.openclaw/browser/openclaw/user-data`
- Direct CDP: `curl http://127.0.0.1:18800/json`
- Legacy Chrome debug port `9222` is retired.

## Gmail / Google Calendar

Headless OpenClaw sessions must not call raw `gog`.

Use:

```bash
npx tsx /Users/hd/Developer/cortana/tools/gog/gog-with-env.ts ...
```

Default calendar: `Clawdbot-Calendar`.

## OpenClaw Update

Canonical update flow:

```bash
pnpm update -g openclaw@latest
bash /Users/hd/Developer/cortana/tools/openclaw/post-update.sh
openclaw gateway restart
openclaw status
openclaw gateway health
```

Never use npm for OpenClaw updates.

Post-update handles:
- repo -> runtime cron sync
- doctor checks
- gateway Gog shim
- compatibility shim validation for `/Users/hd/openclaw`

## Runtime Deploy

- Source repo: `/Users/hd/Developer/cortana`
- Runtime state: `/Users/hd/.openclaw`
- Compatibility shim: `/Users/hd/openclaw`
- Standard deploy: `/Users/hd/Developer/cortana/tools/deploy/sync-runtime-from-cortana.sh`
- Standard post-merge: `/Users/hd/Developer/cortana/tools/repo/post-merge-sync.sh`

Do not symlink `~/.openclaw/cron/jobs.json`; gateway destroys symlinks on restart.

## Services

- Watchdog LaunchAgent: `com.cortana.watchdog`
- External service LaunchAgent: `com.cortana.fitness-service`
- Mission Control LaunchAgent: `com.cortana.mission-control`
- Mission Control URL: `http://127.0.0.1:3000`
- External service URL: `http://127.0.0.1:3033`

## Database

Local Postgres DB: `cortana`

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana
```

Core tables:
- `cortana_events`, `cortana_feedback`
- `cortana_patterns`
- `cortana_human_required_actions`
- `cortana_cron_health`, `cortana_tool_health`
- `cortana_immune_incidents`
- `cortana_self_model`, `cortana_budget_log`

## iCloud

Path: `~/Library/Mobile Documents/com~apple~CloudDocs/`

Allowed:
- read
- copy/move files into iCloud

Forbidden:
- move files out of iCloud
- delete from iCloud

## Weather

Primary: `wttr.in`

Fallback Warren, NJ:

```bash
curl -s "https://api.open-meteo.com/v1/forecast?latitude=40.63&longitude=-74.49&current_weather=true&temperature_unit=fahrenheit&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=America/New_York&forecast_days=3"
```

## Market Intelligence

```bash
/Users/hd/Developer/cortana/tools/market-intel/market-intel.sh --ticker NVDA
/Users/hd/Developer/cortana/tools/market-intel/market-intel.sh --portfolio
/Users/hd/Developer/cortana/tools/market-intel/market-intel.sh --pulse
```

Uses Alpaca local endpoint at `http://localhost:3033/alpaca/portfolio` for positions.
