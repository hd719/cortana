# Task Board State Enforcer

`state-enforcer.sh` enforces atomic `cortana_tasks` state transitions and writes an audit trail to `cortana_events`.

Path: `tools/task-board/state-enforcer.sh`

## Database

- DB: `cortana`
- psql: `/opt/homebrew/opt/postgresql@17/bin/psql`

## Commands

### 0) research-to-tasks

```bash
tools/task-board/research-to-tasks.sh [--input recommendations.json] [--dry-run]
# or cat recommendations.json | tools/task-board/research-to-tasks.sh --dry-run
```

Converts research recommendations into `cortana_tasks`.

Input JSON format:

```json
[
  {
    "title": "Task title",
    "description": "Task details",
    "priority": 3,
    "agent_role": "huragok",
    "auto_executable": true
  }
]
```

Behavior:
- creates one task per recommendation with `source = 'research-pipeline'`
- clamps priority to range 1..5
- if `auto_executable=true`, task is marked ready via `execute_at = CURRENT_TIMESTAMP`
- logs run + per-task events to `cortana_events`
- `--dry-run` prints what would be created without inserting tasks


### 1) spawn-start

```bash
tools/task-board/state-enforcer.sh spawn-start <task_id> <assigned_to>
```

Rules:
- Allowed only when task status is `ready`
- Sets:
  - `status = 'in_progress'`
  - `assigned_to = <assigned_to>`
  - `updated_at = CURRENT_TIMESTAMP`
- **Hard requirement:** run this in the same action block as sub-agent spawn. If it returns `ok=false`, abort the spawn.

### 2) complete

```bash
tools/task-board/state-enforcer.sh complete <task_id> "<outcome>"
```

Rules:
- Allowed only when task status is `in_progress`
- Sets:
  - `status = 'completed'`
  - `completed_at = NOW()`
  - `outcome = <outcome>`
  - `assigned_to = NULL` (ownership cleanup on terminal transition)
  - `updated_at = CURRENT_TIMESTAMP`

### 3) fail

```bash
tools/task-board/state-enforcer.sh fail <task_id> "<reason>"
```

Rules:
- Allowed only when task status is `in_progress`
- Sets:
  - `status = 'failed'`
  - `outcome = <reason>`
  - `assigned_to = NULL` (ownership cleanup on terminal transition)
  - `updated_at = CURRENT_TIMESTAMP`

> Note: migration `migrations/021_task_status_failed.sql` adds `failed` to the `cortana_tasks_status_check` constraint.

### 4) check-orphans

```bash
tools/task-board/state-enforcer.sh check-orphans
```

Finds tasks that are:
- `status = 'in_progress'`
- stale for more than 2 hours (`updated_at`/`created_at`)
- and whose `assigned_to` label has **no active sub-agent label match** based on lifecycle events in `cortana_event_bus_events`
  - active = `agent_spawned` with no later matching terminal event (`agent_completed`, `agent_failed`, `agent_timeout`)

Returns orphan list as JSON and logs a `task_orphan_check` event.

### 5) reset-stale

```bash
tools/task-board/state-enforcer.sh reset-stale
```

Finds tasks that are:
- `status = 'ready'`
- stale for more than 7 days (`updated_at`/`created_at`)

Touches them back to `ready` and appends a staleness note into `metadata.stale_reset` with timestamp and note.

Logs `task_stale_reset` and returns all touched task rows in JSON.

### 6) stale-detector (auto-cleanup)

```bash
tools/task-board/stale-detector.sh
```

Single-run detector + auto-cleaner that:

- Flags stale `pending` tasks older than 7 days with no activity by setting:
  - `metadata.stale_flagged = true`
  - `metadata.stale_flagged_at = <timestamp>`
- Resets orphaned `in_progress` tasks older than 2 hours (no matching active sub-agent label) back to `pending` and writes `metadata.orphan_reset`
- Emits per-task action events plus a run summary event in `cortana_events`
- Prints a JSON report of all actions taken

Idempotency:
- Already-flagged pending tasks are skipped
- Already-reset orphaned tasks become `pending`, so they are naturally skipped on reruns

### 6b) reset-engine (sync + cleanup + tomorrow stack)

```bash
npx tsx tools/task-board/reset-engine.ts
npx tsx tools/task-board/reset-engine.ts --json
```

Workflow:
- runs `completion-sync` first so finished sub-agent work lands in `cortana_tasks`
- runs `aggressive-reconcile --apply` to repair active-run / merged-PR drift
- runs `stale-detector` to flag stale `ready` work and requeue orphaned `in_progress` work
- promotes overdue `scheduled` tasks to `ready`
- auto-closes `ready` tasks that were already stale-flagged and then remained idle past the grace window
- emits a tomorrow mission stack from the cleaned board state

Default output is a one-page tomorrow mission stack. `--json` returns the full workflow summary plus the rendered stack.

### 7) state-integrity audit/heal

```bash
npx tsx tools/task-board/state_integrity.ts --dry-run
npx tsx tools/task-board/state_integrity.ts --heal-ready-active-run
```

Detects integrity drift and can optionally auto-heal tasks stuck in `ready` even though active run evidence exists.

- Detects `ready` tasks that still match active `cortana_covenant_runs` by `run_id` or `assigned_to`.
- Optional `--heal-ready-active-run` transitions those tasks to `in_progress` and tags `metadata.auto_heal_spawn_state`.
- Keeps existing checks for orphaned `in_progress` tasks and completed parents with pending children.

### 8) integrity-guard (post-merge/cron gate)

```bash
# machine readable + non-zero exit when violations exist
npx tsx tools/task-board/integrity-guard.ts

# human summary + JSON
npx tsx tools/task-board/integrity-guard.ts --pretty

# also emit cortana_events audit row
npx tsx tools/task-board/integrity-guard.ts --log-event
```

Checks and exits `1` when any of these are non-zero:
- completed tasks with stale `assigned_to`
- `in_progress` tasks without active session mapping (`run_id`/`assigned_to` not present in active `cortana_covenant_runs`)
- tasks with invalid priorities (`NULL` or outside 1..5)

Exit behavior is automation-friendly (`0` pass, `1` violations).

## Output format

Every command prints JSON to stdout:
- transition commands include `ok`, `error` (if any), updated `task`, and `event_id`
- report commands include arrays and counts plus `event_id`

## Event logging

All commands write to `cortana_events` with:
- `source = 'task-board-state-enforcer'`
- transition events: `task_state_transition` / `task_state_transition_rejected`
- orphan scan: `task_orphan_check`
- stale reset: `task_stale_reset`

## Examples

```bash
# start work on a pending task
tools/task-board/state-enforcer.sh spawn-start 123 huragok-state-enforcer

# mark success
tools/task-board/state-enforcer.sh complete 123 "Implemented state guard"

# mark failure
tools/task-board/state-enforcer.sh fail 124 "Blocked by missing API token"

# report stale in-progress tasks with missing active label
tools/task-board/state-enforcer.sh check-orphans

# add stale-reset metadata to old pending tasks
tools/task-board/state-enforcer.sh reset-stale
```

### 7) aggressive-reconcile (merge/run/ambiguity hardening)

```bash
# inspect only
tools/task-board/aggressive-reconcile.sh --pretty

# apply fixes
tools/task-board/aggressive-reconcile.sh --apply --pretty
```

Behavior:
- closes tasks when linked GitHub PR metadata resolves to merged (`repo + pr_number` or `pr_url`)
- marks tasks `in_progress` when an active sub-agent run is detected via `run_id` / metadata linkage
- reverts ambiguous autosync failures (`failed -> ready`) when prior failure evidence is `unknown` / ambiguous
- writes auditable metadata under `metadata.aggressive_reconcile` and emits `task_state_reconciled` events
