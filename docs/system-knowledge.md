# System Knowledge

## Calendar Setup (Critical Reference)
- **Primary calendar tool:** `gog` (Google Calendar CLI)
- **Default calendar ID:** `Clawdbot-Calendar` — this is where ALL real events live
- **Primary calendar (`hameldesai3@gmail.com`) is EMPTY** — never use it for queries
- **Available calendars:**
  - `Clawdbot-Calendar` — main events, classes, earnings, reminders (USE THIS)
  - `uclaqrlv0qe3p2u57ndlp1mrt37tapdq@import.calendar.google.com` — Canvas/school events
  - `Formula 1` — F1 race schedule
  - `ICC Cricket` — cricket schedule
- **Correct query syntax:** `gog cal list "Clawdbot-Calendar" --from today --plain`
- **CalDAV/khal also works:** `khal list today 3d` (pulls from all synced calendars)
- **If `gog cal list` returns "No events"** — you forgot the calendar ID. Always pass `"Clawdbot-Calendar"`.
- **vdirsyncer** syncs CalDAV → local, khal reads local. gog reads Google API directly.

## Systems & Infrastructure (Feb 2026)
- **The Covenant** — Sub-agent framework with 5 role-routed agents: Huragok (systems/infra), Researcher (deep research), Monitor (patterns/health), Librarian (docs/knowledge), Oracle (forecasting/strategy). Operating model has shifted to strict role routing + auto-chain execution.
- **Proactive Intelligence** — `cortana_watchlist` table for monitoring; self-healing tiers (auto-fix/alert/ask first) implemented. Immune system handles transient failures automatically.
- **Task Queue** — `cortana_tasks` table for persistent work queue. Tasks from conversations auto-execute during heartbeats. Queue active with mostly completed February buildout and a small set of pending follow-ups.
- **Session Cleanup** — Daily 3 AM cron deletes sessions >400KB. Last cleanup freed 2.37MB from 5 sessions.
- **Database** — PostgreSQL with 10+ tables for memory, patterns, feedback, events, tasks. Learning loop tracks corrections.
- **Watchdog** — Local LaunchAgent (`~/Desktop/services/watchdog/`) runs every 15 min. $0 reliability layer for cron health, tool checks, budget guards.
- **Git primary** — README.md is master doc. Obsidian sync killed. All changes committed to github.com/hd719/cortana.
- **Weather fallback** — Open-Meteo as backup when wttr.in fails. Full API integration in skills/weather.
- **Market status** — Built static 2026 NYSE/NASDAQ holiday calendar in `skills/markets/check_market_status.sh`. Never guess market status again.
- **Default model** — openai-codex/gpt-5.3-codex (primary), fallback claude-opus-4-6 (to be removed after stability sign-off)

## System Access & Auth
- **Full Disk Access** — OpenClaw/Node has FDA granted (Feb 16, 2026). Can access Downloads, Desktop, Documents, TCC-protected folders.
- **gog fully headless** — OAuth credentials installed + keyring switched to macOS Keychain. No password prompts in cron/automated contexts.
- **Watchdog LaunchAgent** — `com.cortana.watchdog`, runs every 15 min via launchd, auto-starts on boot. $0 reliability layer.
- **cortana-external repo path** — `/Users/hd/Developer/cortana-external` (not `/Users/hd/cortana-external`). Reinforced Feb 24, 2026.
