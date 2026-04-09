# Task Board

The task board is Cortana's durable execution queue.

## Core Model

Tasks live in `cortana_tasks` and can optionally roll up into `cortana_epics`.

Canonical lifecycle:

- `backlog`
- `ready`
- `scheduled`
- `in_progress`
- `completed`
- `failed`
- `cancelled`

`ready` is the actionable state. `backlog` is intentionally non-executable until promoted.

## Execution Rules

- only `ready` tasks should be auto-executed
- auto-execution requires `auto_executable = true`
- dependency-blocked tasks should not be launched
- every spawned specialist run tied to a task must atomically move that task into `in_progress`

## Conversation Intake

After each conversation, Cortana should detect actionable work and:

- insert a standalone task when the ask is clear and low-ambiguity
- create or defer epic decomposition when the work is project-shaped
- avoid multiple task-board mutations inline when the work is too complex for a single safe tool call

## Synchronization Rule

If a specialist completes work tied to an existing task, the task board must be reconciled before Cortana reports completion to Hamel.

## Primary Source Docs

- [Task board](../../../docs/source/doctrine/task-board.md)
- [Learning loop](../../../docs/source/doctrine/learning-loop.md)
