# Spawn Dedupe Guard

## Goal
Prevent duplicate concurrent sub-agent launches for the same logical task, and reduce ghost runs.

## Implementation
File: `tools/covenant/spawn_guard.py`

### Key computation
Dedupe key format:

`task:<task_id|none>|label:<normalized_label>`

Normalization:
- lower-case
- replace non-alphanumeric chars with `-`
- collapse repeated dashes
- trim leading/trailing dashes

Example:
- label: `Huragok migration hygiene`
- task_id: `4242`
- key: `task:4242|label:huragok-migration-hygiene`

### Behavior
- `claim`: before spawn, attempts to acquire the dedupe key.
  - If no active run: returns `claimed` and stores run metadata.
  - If active run exists for same key: returns `deduped` with existing run info.
- `release`: marks the run completed/failed/etc.
- Active entries use TTL (default 3600s) to avoid stale locks forever.

### Decision logging
- Attempts DB event bus publish (`cortana_event_bus_publish`) as `agent_spawn_dedupe`.
- If DB path is unavailable, falls back to JSONL at:
  - `reports/spawn_guard.decisions.jsonl`

## CLI usage
### Claim
```bash
python3 tools/covenant/spawn_guard.py claim \
  --label "Huragok migration hygiene" \
  --task-id 4242 \
  --run-id run-abc
```

### Release
```bash
python3 tools/covenant/spawn_guard.py release \
  --label "Huragok migration hygiene" \
  --task-id 4242 \
  --run-id run-abc
```

### Demo (simulated duplicate prevention)
```bash
python3 tools/covenant/spawn_guard.py demo
```
