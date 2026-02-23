# Task Board — Cortana's Planning & Execution System

## Problem
Cortana has no structured way to plan multi-step work. Tasks are a flat list with no dependencies, subtasks, or execution plans. Complex work (like trip prep, project builds, research) gets lost or requires Hamel to manually break things down.

## Solution
A local task board in PostgreSQL with epic → task → subtask hierarchy, dependency tracking, and automatic execution via heartbeats and sub-agents.

## How It Works

```
Conversation/Event → Detect → Decompose → Plan → Execute → Report
```

1. **Detect** — Cortana picks up actionable items from conversations, calendar events, or patterns
2. **Decompose** — Break into epic → tasks → subtasks with dependencies
3. **Plan** — Order by dependencies and deadlines
4. **Execute** — Spawn sub-agents or queue for heartbeat pickup
5. **Report** — Surface progress in Telegram (morning brief, on-demand, inline buttons)

## Example

```
Epic: "Mexico Trip Prep" (deadline: Feb 19 6:39 AM)
├── Task: Check weather in Mexico City → done
├── Task: Generate packing list (depends on: weather) → done
├── Task: Confirm Uber to EWR → done (cron set)
├── Task: International phone plan → pending
└── Task: Pesos / cash → pending
```

## Schema

### cortana_epics
| Column | Type | Purpose |
|--------|------|---------|
| id | serial | PK |
| title | text | Epic name |
| source | text | conversation / calendar / pattern / manual |
| status | text | active / completed / cancelled |
| deadline | timestamptz | Optional deadline |
| created_at | timestamptz | When created |
| completed_at | timestamptz | When finished |
| metadata | jsonb | Extra context |

### cortana_tasks (updated)
| Column | Type | Purpose |
|--------|------|---------|
| id | serial | PK |
| epic_id | int | FK to epics (nullable for standalone tasks) |
| parent_id | int | FK to self (for subtasks) |
| depends_on | int[] | Task IDs this is blocked by |
| title | text | Task name |
| description | text | Details / execution plan |
| status | text | pending / blocked / in_progress / done / cancelled |
| priority | int | 1 = urgent, 5 = low |
| auto_executable | bool | Can Cortana do this without asking? |
| execution_plan | text | How to execute (tool calls, steps) |
| assigned_to | text | sub-agent session key if spawned |
| created_at | timestamptz | When created |
| execute_at | timestamptz | Scheduled execution time |
| remind_at | timestamptz | When to remind Hamel |
| completed_at | timestamptz | When finished |

## Telegram UI

**On-demand:**
- "Show me tasks" → formatted board view
- "What's blocked?" → show dependency issues
- Inline buttons: ✅ Done | ⏭️ Skip | 🔄 Reprioritize

**Automatic:**
- Morning brief includes open task count + today's priorities
- Heartbeat checks board, executes ready auto-tasks
- Alerts when deadlines approach with incomplete tasks

## Execution Flow (Heartbeat)

```sql
-- Find next executable task
SELECT * FROM cortana_tasks 
WHERE status = 'pending' 
  AND auto_executable = TRUE
  AND (depends_on IS NULL OR NOT EXISTS (
    SELECT 1 FROM cortana_tasks t2 
    WHERE t2.id = ANY(cortana_tasks.depends_on) 
    AND t2.status != 'done'
  ))
  AND (execute_at IS NULL OR execute_at <= NOW())
ORDER BY priority ASC, created_at ASC 
LIMIT 1;
```

## What This Enables
- **Autonomous task detection** — conversations become epics/tasks automatically
- **Proactive intelligence** — patterns trigger task creation
- **Multi-step planning** — proper decomposition before execution
- **Visibility** — Hamel always knows what's in flight
- **Accountability** — nothing falls through the cracks

## Build Plan (implemented)
- ✅ Create/alter DB tables (epics + updated tasks)
- ✅ Add epic detection logic to main session (conversation → epic)
- ✅ Update heartbeat to detect + check board and execute
- ✅ Add Telegram commands for board interaction
- ✅ Integrate into morning brief
