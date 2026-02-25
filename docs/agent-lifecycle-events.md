# Agent Lifecycle Events

This adds first-class sub-agent lifecycle telemetry to the PostgreSQL event bus so Cortana and monitoring consumers can observe agent orchestration in real time.

## Event types

New event bus types:

- `agent_spawned`
- `agent_completed`
- `agent_failed`
- `agent_timeout`

These are now accepted by `cortana_event_bus_events.event_type` via migration `migrations/015_event_bus_agent_lifecycle_types.sql`.

## Publisher tool

Path: `tools/covenant/lifecycle_events.py`

The tool publishes through PostgreSQL function `cortana_event_bus_publish(...)` with source `agent_lifecycle`.

### Functions

- `publish_spawn(agent_role, task_id, chain_id, label, model)`
- `publish_completion(agent_role, task_id, chain_id, label, duration_ms, outcome_summary)`
- `publish_failure(agent_role, task_id, chain_id, label, error, duration_ms)`
- `publish_timeout(agent_role, task_id, chain_id, label, timeout_seconds)`

### CLI usage

```bash
# Spawn
./tools/covenant/lifecycle_events.py spawn \
  --agent-role huragok \
  --task-id 128 \
  --chain-id cfd656d7-aa8e-430e-ba4f-6da08fe3d087 \
  --label huragok-lifecycle-events \
  --model openai-codex/gpt-5.3-codex

# Completion
./tools/covenant/lifecycle_events.py complete \
  --agent-role huragok \
  --task-id 128 \
  --chain-id cfd656d7-aa8e-430e-ba4f-6da08fe3d087 \
  --label huragok-lifecycle-events \
  --duration-ms 4200 \
  --outcome-summary "Implemented lifecycle event bus integration"

# Failure
./tools/covenant/lifecycle_events.py fail \
  --agent-role huragok \
  --task-id 128 \
  --chain-id cfd656d7-aa8e-430e-ba4f-6da08fe3d087 \
  --label huragok-lifecycle-events \
  --error "psql unavailable" \
  --duration-ms 1500

# Timeout
./tools/covenant/lifecycle_events.py timeout \
  --agent-role huragok \
  --task-id 128 \
  --chain-id cfd656d7-aa8e-430e-ba4f-6da08fe3d087 \
  --label huragok-lifecycle-events \
  --timeout-seconds 600
```

## Validation query

```sql
SELECT id, created_at, event_type, source, payload
FROM cortana_event_bus_events
WHERE event_type IN ('agent_spawned', 'agent_completed', 'agent_failed', 'agent_timeout')
ORDER BY id DESC
LIMIT 20;
```

## Notes

- Events are persisted in `cortana_event_bus_events` and also fanned out to `NOTIFY` channels by `cortana_event_bus_publish`:
  - `cortana_bus`
  - `cortana_<event_type>` (for example: `cortana_agent_spawned`)
- Keep `payload` compact; put large context in database records/files and reference by ID.
