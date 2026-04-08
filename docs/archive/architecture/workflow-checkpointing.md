# Durable Workflow Checkpointing (Prototype)

This is a lightweight prototype of durable execution for Covenant chains.

Goal: if a multi-step workflow crashes mid-run, we can resume from the latest checkpoint in PostgreSQL instead of restarting from step 1.

## Scope

Implemented in `tools/covenant/checkpoint.ts` with five core operations:

- `save(workflow_id, step_id, state, metadata)`
- `load(workflow_id)`
- `resume(workflow_id)`
- `list --active`
- `cleanup --older-than 7d`

This is intentionally simple and **not** a full Graphile Worker replacement.

## Database Schema

Migration: `migrations/020_workflow_checkpoints.sql`

Table: `cortana_workflow_checkpoints`

Columns:

- `id BIGSERIAL PRIMARY KEY`
- `workflow_id UUID NOT NULL`
- `step_id TEXT NOT NULL`
- `state TEXT NOT NULL` with check:
  - `queued | running | completed | failed | paused`
- `agent_role TEXT`
- `task_id BIGINT` (FK to `cortana_tasks(id)`, `ON DELETE SET NULL`)
- `trace_id TEXT`
- `payload JSONB NOT NULL DEFAULT '{}'`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Indexes:

- `workflow_id`
- `state`
- `(workflow_id, created_at DESC)` for latest-checkpoint lookups

## CLI Usage

```bash
# Save checkpoint
npx tsx tools/covenant/checkpoint.ts save \
  11111111-1111-1111-1111-111111111111 \
  planner \
  running \
  --metadata '{"agent_role":"huragok","task_id":140,"trace_id":"abc-123"}'

# Load latest checkpoint
npx tsx tools/covenant/checkpoint.ts load 11111111-1111-1111-1111-111111111111

# Compute resume decision
npx tsx tools/covenant/checkpoint.ts resume 11111111-1111-1111-1111-111111111111

# List latest checkpoint per workflow (all)
npx tsx tools/covenant/checkpoint.ts list

# List in-flight workflows only
npx tsx tools/covenant/checkpoint.ts list --active

# Cleanup stale rows
npx tsx tools/covenant/checkpoint.ts cleanup --older-than 7d
```

## Resume Semantics (Prototype)

`resume(workflow_id)` uses the latest checkpoint row and applies these rules:

1. No checkpoint found → `start`
2. Last state is `queued|running|paused|failed` → `retry` current `step_id`
3. Last state is `completed`:
   - if `payload.next_step_id` exists → `continue` with that step
   - otherwise → `done`

This keeps restart behavior deterministic while avoiding workflow-engine complexity.

## Operational Notes

- `save` is append-only: every transition writes a new row.
- `payload` stores arbitrary JSON metadata for diagnostics and handoff.
- `task_id`, `agent_role`, and `trace_id` can be passed in `metadata` and are promoted to first-class columns.
- Cleanup supports compact intervals: `Nd`, `Nh`, `Nm` (e.g. `7d`, `12h`, `30m`).

## Apply Migration

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana -f migrations/020_workflow_checkpoints.sql
```

## Why this is enough for now

Covenant needs crash recovery for multi-step chains more than it needs a full scheduler.

This prototype proves the core durability pattern:

- persist progress after each step transition,
- load latest state on restart,
- derive next action deterministically.

We can layer retries, backoff, and orchestration policy later without changing this checkpoint table contract.
