# Covenant Parallel Fan-Out/Fan-In Executor

## What shipped

Covenant now supports **parallel step groups** with barrier synchronization:

- Steps with the same `parallel_group` dispatch concurrently.
- Executor returns **all dispatch-ready step IDs** in that group.
- Any downstream step that depends on one member of a parallel group is automatically blocked until **all members** finish.
- A new `fan_in.py` utility aggregates and summarizes HAB artifacts for a completed parallel group.

---

## Roland changes (`tools/covenant/planner.py`)

### New step field

Each step now includes:

- `parallel_group: string | null`

### New handoff pattern

Added `parallel_research` pattern:

- Fan-out: multiple `agent.researcher.v1` steps run in parallel.
- Fan-in: `agent.oracle.v1` synthesis step runs after barrier clears.

Roland supports optional request field:

- `parallel_research_angles: string[]` (defaults to 3 angles)

Generated plan shape:

- `step_1..step_n`: parallel Researchers in same `parallel_group`
- `step_(n+1)`: Oracle synthesis

---

## Executor changes (`tools/covenant/executor.py`)

### Parallel dispatch

Use `next_ready_steps(...)` to return one-or-many steps:

- Non-parallel flow -> single ready step
- Parallel flow -> all ready steps for that `parallel_group`

### Barrier logic

Dependency expansion enforces group barriers:

- If step B depends on step A
- and step A belongs to parallel group `G`
- then B implicitly depends on **all step IDs in `G`**

This guarantees fan-in only starts after full fan-out completion.

### Execution payload

`build_execution_state(...)` now includes:

- `dispatch_step_ids: string[]`

for concurrent dispatch orchestration.

---

## Fan-In utility (`tools/covenant/fan_in.py`)

CLI:

```bash
./tools/covenant/fan_in.py aggregate --chain-id <uuid> --group <name>
./tools/covenant/fan_in.py check --chain-id <uuid> --group <name> --completed step_1,step_2
./tools/covenant/fan_in.py summarize --chain-id <uuid> --group <name>
```

### Commands

- `aggregate(chain_id, parallel_group)`
  - Collects HAB artifacts for that group from `cortana_handoff_artifacts`.
- `check_barrier(chain_id, parallel_group)`
  - Returns whether all step IDs in the group are complete.
- `summarize(chain_id, parallel_group)`
  - Produces a unified context block from aggregated artifacts.

> Note: `fan_in.py` resolves plans from:
> - `tools/covenant/chains/<chain_id>.plan.json`
> - `/tmp/covenant-spawn/<chain_id>.plan.json`

---

## Schema update (`tools/covenant/protocol_schema.json`)

Added to step schema:

- `parallel_group: ["string", "null"]`

Also added execution field:

- `dispatch_step_ids: string[]`

---

## Test scenario

A mock plan with 3 parallel research steps validates:

1. Executor returns all 3 fan-out steps as dispatch-ready.
2. Completing 1 or 2 steps keeps fan-in step blocked.
3. Only after all 3 complete does synthesis step become dispatch-ready.

Run:

```bash
python3 /Users/hd/Developer/cortana/tools/covenant/tests_parallel_executor.py
```
