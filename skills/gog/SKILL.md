---
name: gog
description: >
  Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.
  USE WHEN: Gmail search/send, Google Calendar events, Google Drive files, Google Sheets data, Google Docs.
  DON'T USE: iCloud calendars (use caldav-calendar), Apple Notes (use apple-notes), Notion (use notion skill).
homepage: https://gogcli.sh
metadata: {"clawdbot":{"emoji":"🎮","requires":{"bins":["gog"]},"install":[{"id":"brew","kind":"brew","formula":"steipete/tap/gogcli","bins":["gog"],"label":"Install gog (brew)"}]}}
---

# gog

Use `gog` for Gmail/Calendar/Drive/Contacts/Sheets/Docs. Requires OAuth setup.

## Headless Rule

Inside OpenClaw, cron jobs, or any other non-interactive/headless execution, **do not call raw `gog` directly** for Gmail or Calendar reads/writes.

Use the env-aware wrapper instead:

- `npx tsx /Users/hd/Developer/cortana/tools/gog/gog-with-env.ts ...`

Why:
- raw `gog` may prompt for the keyring password and fail with `no TTY available`
- the wrapper injects `GOG_KEYRING_PASSWORD` from the durable gateway env sources

If Gog is genuinely unauthenticated, tell Hamel to re-auth locally. Do **not** ask him to paste the keyring passphrase into chat.

## When NOT to Use This Skill

❌ "Add event to my iCloud calendar" → Use **caldav-calendar** skill
❌ "Create an Apple Note" → Use **apple-notes** skill
❌ "Add to my Notion database" → Use **notion** skill
❌ "What's on my Outlook calendar?" → Not supported (use browser or web_fetch)

Setup (once)
- Run these only in a local interactive terminal:
  - `gog auth credentials /path/to/client_secret.json`
  - `gog auth add you@gmail.com --services gmail,calendar,drive,contacts,sheets,docs`
  - `gog auth list`

Common commands
- Headless/OpenClaw Gmail search: `npx tsx /Users/hd/Developer/cortana/tools/gog/gog-with-env.ts gmail search 'newer_than:7d' --max 10 --no-input`
- Headless/OpenClaw Gmail send: `npx tsx /Users/hd/Developer/cortana/tools/gog/gog-with-env.ts gmail send --to a@b.com --subject "Hi" --body "Hello"`
- Headless/OpenClaw Calendar list: `npx tsx /Users/hd/Developer/cortana/tools/gog/gog-with-env.ts calendar events <calendarId> --from <iso> --to <iso> --json --no-input`
- Headless/OpenClaw Calendar create: `npx tsx /Users/hd/Developer/cortana/tools/gog/gog-with-env.ts calendar create <calendarId> --summary "Title" --from <iso> --to <iso>`
- Drive search: `gog drive search "query" --max 10`
- Contacts: `gog contacts list --max 20`
- Sheets get: `gog sheets get <sheetId> "Tab!A1:D10" --json`
- Sheets update: `gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED`
- Sheets append: `gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS`
- Sheets clear: `gog sheets clear <sheetId> "Tab!A2:Z"`
- Sheets metadata: `gog sheets metadata <sheetId> --json`
- Docs export: `gog docs export <docId> --format txt --out /tmp/doc.txt`
- Docs cat: `gog docs cat <docId>`

Notes
- Set `GOG_ACCOUNT=you@gmail.com` to avoid repeating `--account`.
- For scripting, prefer `--json` plus `--no-input`.
- In OpenClaw sessions, use `tools/gog/gog-with-env.ts` for Gmail/Calendar commands instead of raw `gog`.
- Sheets values can be passed via `--values-json` (recommended) or as inline rows.
- Docs supports export/cat/copy. In-place edits require a Docs API client (not in gog).
- Confirm before sending mail or creating events.

## Hamel's Setup

**Account:** `hameldesai3@gmail.com`
**Services:** gmail, calendar

```bash
export GOG_ACCOUNT=hameldesai3@gmail.com

# Clawdbot-Calendar ID (syncs to Google Calendar)
CALENDAR_ID="60e1d0b7ca7586249ee94341d65076f28d9b9f3ec67d89b0709371c0ff82d517@group.calendar.google.com"
npx tsx /Users/hd/Developer/cortana/tools/gog/gog-with-env.ts \
  calendar events "$CALENDAR_ID" --from 2026-02-12 --to 2026-02-14 --json --no-input
```

**If auth expires:**
```bash
gog auth add hameldesai3@gmail.com --services gmail,calendar
```
