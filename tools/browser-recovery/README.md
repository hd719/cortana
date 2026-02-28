# OpenClaw Browser Recovery

Quick recovery for OpenClaw's managed browser when Chrome crashes or needs restart.

## Standard Tabs

1. **Home Assistant** — homeassistant.local:8123
2. **Gmail** — mail.google.com
3. **Google Calendar** — calendar.google.com
4. **Amazon Orders** — amazon.com/gp/your-account/order-history

## Usage

### Via Script
```bash
~/openclaw/tools/browser-recovery/restore-tabs.sh
```

### Via Cortana
Just say: "Restore browser tabs" or "Chrome crashed, fix it"

### What It Does
1. Kills all Chrome instances
2. Starts OpenClaw browser (port 18800)
3. Opens all standard tabs

## Adding/Removing Tabs

Edit `restore-tabs.sh` and modify the `TABS` array.

## Notes

- This uses OpenClaw's managed browser profile at `~/.openclaw/browser/openclaw/user-data`
- Sessions persist across restarts (cookies saved)
- First run after fresh install requires login to all services
