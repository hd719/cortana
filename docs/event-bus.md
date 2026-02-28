# Nervous System Bus: Event-Driven Automation Backbone

## Overview

The local event bus now runs on PostgreSQL `LISTEN/NOTIFY` with durable event storage.

Design choice:
- **Primary transport:** PostgreSQL `NOTIFY`
- **Durability + replay:** `cortana_event_bus_events` table
- **Why this wins here:** PostgreSQL is already always-on in this environment, so no extra daemon (Redis) and no file-lock quirks (named pipes / SQLite polling).

## Event Types

Core channels are implemented for:
- `email_received`
- `task_created`
- `calendar_approaching`
- `portfolio_alert`
- `health_update`

Publishing fans out to:
- `cortana_bus` (global stream)
- `cortana_<event_type>` (typed stream, e.g. `cortana_task_created`)

## Database Infrastructure

Migration: `migrations/012_event_bus.sql`

Created objects:
- `cortana_event_bus_events` table (durable event log)
- `cortana_event_bus_publish(...)` function (insert + notify)
- `cortana_event_bus_mark_delivered(event_id)` helper
- Trigger: `cortana_task_created_notify` on `cortana_tasks`
- Trigger: `cortana_events_event_bus_bridge` on `cortana_events`

### PoC Wiring (existing signals)

1. **Task created**
   - Any `INSERT` to `cortana_tasks` emits `task_created`
2. **Event bridge**
   - Any `INSERT` to `cortana_events` with event_type in:
     `email_received`, `calendar_approaching`, `portfolio_alert`, `health_update`
     is forwarded into the event bus

## Runtime Tools

### Listener daemon

Path: `tools/event-bus/listener.py`

Features:
- Tails durable `cortana_event_bus_events` table for all core event types
- Near-real-time polling (default 1s) to avoid dropped notifications
- Writes JSONL logs to `~/openclaw/tmp/event-bus-listener.log`
- Optional `--mark-delivered` to mark seen events

Run:

```bash
python3 ~/openclaw/tools/event-bus/listener.py --db cortana --mark-delivered
```

### Publisher helper

Path: `tools/event-bus/publish.py`

Examples:

```bash
# Minimal publish
python3 ~/openclaw/tools/event-bus/publish.py task_created --source manual --payload '{"task_id":123}'

# Health update from file
python3 ~/openclaw/tools/event-bus/publish.py health_update --source heartbeat --payload-file /tmp/health.json
```

## SQL examples

```sql
-- Manual publish inside psql
SELECT cortana_event_bus_publish(
  'portfolio_alert',
  'portfolio-monitor',
  '{"symbol":"AAPL","change_pct":-5.2}'::jsonb,
  NULL
);

-- View recent events
SELECT id, created_at, event_type, source, delivered
FROM cortana_event_bus_events
ORDER BY id DESC
LIMIT 25;
```

## Operational Notes

- This implementation is local-first and intentionally lightweight.
- Consumers that need guaranteed processing should read from `cortana_event_bus_events` (durable log), not only transient notifications.
- `LISTEN/NOTIFY` payload size is limited by PostgreSQL; keep payloads compact and store larger context in DB rows/files referenced by ID.
