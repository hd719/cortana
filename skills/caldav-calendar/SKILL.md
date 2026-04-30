---
name: caldav-calendar
description: >
  Sync and query CalDAV calendars using vdirsyncer + khal. Works on macOS and Linux.
  USE WHEN: iCloud calendar, Fastmail, Nextcloud, any CalDAV server, creating/viewing local calendar events.
  DON'T USE: Gmail/Google Calendar (use gog skill), Outlook/Microsoft 365 calendars.
  NOTE: On this machine, Clawdbot-Calendar health uses Gog as source of truth; the vdirsyncer/khal mirror is legacy/advisory.
metadata: {"clawdbot":{"emoji":"📅","os":["darwin","linux"],"requires":{"bins":["vdirsyncer","khal"]},"install":[{"id":"apt","kind":"apt","packages":["vdirsyncer","khal"],"bins":["vdirsyncer","khal"],"label":"Install vdirsyncer + khal via apt"}]}}
---

# CalDAV Calendar (vdirsyncer + khal)

**vdirsyncer** syncs CalDAV calendars to local `.ics` files. **khal** reads and writes them.

## Clawdbot-Calendar Source of Truth

For **Clawdbot-Calendar**, use the Gog skill and `tools/gog/gog-with-env.ts` as the source of truth. The local vdirsyncer/khal mirror is legacy/advisory on this machine.

Do not run `vdirsyncer sync clawdbot_calendar` from a headless monitor or cron when `~/.config/vdirsyncer/google_token.json` is missing. It opens a browser OAuth callback and can hang. Treat stale local `.ics` files as a low-priority mirror issue unless a caller explicitly requires khal/local ICS.

Health check:
```bash
npx tsx /Users/hd/Developer/cortana/tools/calendar/calendar-health.ts --json
```

## When NOT to Use This Skill

❌ "Search my Gmail for calendar invites" → Use **gog** skill (Gmail)
❌ "What's on my Google Calendar?" → Use **gog** skill (gog calendar events)
❌ "Is Clawdbot-Calendar healthy?" → Use `tools/calendar/calendar-health.ts` or the **gog** skill, not vdirsyncer
❌ "Add event to Outlook/365" → Not supported here
❌ "Set a reminder" → Use **cron** for time-based reminders, or Apple Reminders

## Sync First

Always sync before querying or after making changes:
```bash
vdirsyncer sync
```

## View Events

```bash
khal list                        # Today
khal list today 7d               # Next 7 days
khal list tomorrow               # Tomorrow
khal list 2026-01-15 2026-01-20  # Date range
khal list -a Work today          # Specific calendar
```

## Search

```bash
khal search "meeting"
khal search "dentist" --format "{start-date} {title}"
```

## Create Events

```bash
khal new 2026-01-15 10:00 11:00 "Meeting title"
khal new 2026-01-15 "All day event"
khal new tomorrow 14:00 15:30 "Call" -a Work
khal new 2026-01-15 10:00 11:00 "With notes" :: Description goes here
```

After creating, sync to push changes:
```bash
vdirsyncer sync
```

## Edit Events (interactive)

`khal edit` is interactive — requires a TTY. Use tmux if automating:

```bash
khal edit "search term"
khal edit -a CalendarName "search term"
khal edit --show-past "old event"
```

Menu options:
- `s` → edit summary
- `d` → edit description
- `t` → edit datetime range
- `l` → edit location
- `D` → delete event
- `n` → skip (save changes, next match)
- `q` → quit

After editing, sync:
```bash
vdirsyncer sync
```

## Delete Events

Use `khal edit`, then press `D` to delete.

## ⚠️ Overnight Events (khal Gotcha)

**Problem:** `khal new` with overnight times (e.g., 10pm-2am) creates broken all-day events.

**Solution:** Write ICS files directly for overnight/multi-day timed events:

```bash
cat > /tmp/event.ics << 'EOF'
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Clawdbot//Calendar//EN
BEGIN:VEVENT
UID:unique-id-$(date +%s)@clawdbot
DTSTAMP:20260101T000000Z
DTSTART;TZID=America/New_York:20260211T220000
DTEND;TZID=America/New_York:20260212T020000
SUMMARY:Event Title
LOCATION:Location
DESCRIPTION:Description
END:VEVENT
END:VCALENDAR
EOF
cp /tmp/event.ics ~/.local/share/vdirsyncer/calendars/Clawdbot-Calendar/
vdirsyncer sync clawdbot_calendar
```

**For same-day events:** `khal new` works fine.

## Output Formats

For scripting:
```bash
khal list --format "{start-date} {start-time}-{end-time} {title}" today 7d
khal list --format "{uid} | {title} | {calendar}" today
```

Placeholders: `{title}`, `{description}`, `{start}`, `{end}`, `{start-date}`, `{start-time}`, `{end-date}`, `{end-time}`, `{location}`, `{calendar}`, `{uid}`

## Caching

khal caches events in `~/.local/share/khal/khal.db`. If data looks stale after syncing:
```bash
rm ~/.local/share/khal/khal.db
```

## Initial Setup

### 1. Configure vdirsyncer (`~/.config/vdirsyncer/config`)

Example for iCloud:
```ini
[general]
status_path = "~/.local/share/vdirsyncer/status/"

[pair icloud_calendar]
a = "icloud_remote"
b = "icloud_local"
collections = ["from a", "from b"]
conflict_resolution = "a wins"

[storage icloud_remote]
type = "caldav"
url = "https://caldav.icloud.com/"
username = "your@icloud.com"
password.fetch = ["command", "cat", "~/.config/vdirsyncer/icloud_password"]

[storage icloud_local]
type = "filesystem"
path = "~/.local/share/vdirsyncer/calendars/"
fileext = ".ics"
```

Provider URLs:
- iCloud: `https://caldav.icloud.com/`
- Google: Use `google_calendar` storage type
- Fastmail: `https://caldav.fastmail.com/dav/calendars/user/EMAIL/`
- Nextcloud: `https://YOUR.CLOUD/remote.php/dav/calendars/USERNAME/`

### 2. Configure khal (`~/.config/khal/config`)

```ini
[calendars]
[[my_calendars]]
path = ~/.local/share/vdirsyncer/calendars/*
type = discover

[default]
default_calendar = Home
highlight_event_days = True

[locale]
timeformat = %H:%M
dateformat = %Y-%m-%d
```

### 3. Discover and sync

```bash
vdirsyncer discover   # First time only
vdirsyncer sync
```
