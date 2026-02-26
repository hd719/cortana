# Task Board & Autonomous Queue

This file captures the task board SQL, detection rules, epic/task management, and Telegram UX from `AGENTS.md`.

## Task Queue

Cortana maintains an autonomous task queue in `cortana_tasks` with epic/project grouping via `cortana_epics`.

## Task Lifecycle

Task Lifecycle:
  backlog → ready → in_progress → completed/failed
  scheduled (execute_at future) → ready (when execute_at <= NOW()) → in_progress → completed/failed

- "Do all tasks" = `status='ready'` only
- Auto-executor picks up: `status='ready' AND auto_executable=TRUE`, plus promotes `status='scheduled' AND execute_at <= NOW()` to `ready`
- Backlog items require explicit promotion
- `pending` is legacy alias and should be migrated to `ready`/`scheduled`

## Task Detection Protocol

**⚠️ CRITICAL: After every conversation, extract actionable tasks and epics.**

### Conversation Loop Hook (live)
After every reply in the **main session**, run a quick detector pass on the most recent user message and your response.

- If no actionable task patterns are found → do nothing.
- If exactly one clear standalone task is found and insertion is a **single DB tool call**, insert it immediately.
- If multi-step/project language is found (epic candidate) or confidence is low/ambiguous, defer to heartbeat triage and/or ask a clarification question next turn.
- **Mandatory sync rule:** when any sub-agent run reports completed implementation/research tied to an existing task, immediately reconcile `cortana_tasks` (`status`, `outcome`, `completed_at` as applicable) before reporting completion to Hamel.
- **Launch-proof rule:** never send "launching"/"started" language until the tool returns a valid `runId`. Include the runId in the same confirmation message. If no runId, treat as not started.

**One-tool-call rule enforcement:**
- Main session may do only one direct task-board tool call inline.
- If detection + decomposition would require more than one tool call, queue it for heartbeat/sub-agent handling.

**Confidence threshold:**
- Insert automatically only when confidence is high (≈0.7+): direct request with clear verb/object and no unresolved ambiguity.
- Otherwise: capture as pending clarification in conversation, then create task after confirmation.

### Detection Rules
1. **Scan for trigger patterns** (see `projects/task-board-detection.md` for full guide):
   - Direct requests: "Can you...", "Set up...", "Build...", "Fix...", "Research..."
   - Implicit tasks: "We should...", "I need to...", "Don't forget to..."
   - Multi-step work → create epic first, then subtasks
   - Time mentions → set `due_at` and `remind_at`

2. **Auto-classification**:
   - Priority: urgency words ("ASAP"=1, "urgent"=2, normal=3, "when you can"=4)  
   - Auto-executable: research, file ops, git ops = true. Emails, purchases = false.
   - Epic vs standalone: 2+ related items or project language = epic

## SQL Templates

**Create Epic:**
```sql
INSERT INTO cortana_epics (title, source, status, deadline, metadata)
VALUES ('<title>', 'conversation', 'active', '<deadline_or_null>', '<context_json>');
```

**Create Task (under epic):**
```sql
INSERT INTO cortana_tasks (epic_id, title, description, priority, auto_executable, execution_plan, due_at, remind_at, source)
VALUES (<epic_id>, '<title>', '<details>', <1-5>, <true|false>, '<steps>', '<due_date>', '<remind_date>', 'conversation');
```

**Create Standalone Task:**  
```sql
INSERT INTO cortana_tasks (title, description, priority, auto_executable, execution_plan, due_at, remind_at, source)
VALUES ('<title>', '<details>', <1-5>, <true|false>, '<steps>', '<due_date>', '<remind_date>', 'conversation');
```

## Telegram Task Board UX (live)

Recognize these natural language commands in Telegram and execute against `cortana_tasks` / `cortana_epics`:

- "Show me tasks" / "What's on the board?" → full board view (epics + standalone + blocked)
- "What's blocked?" → only dependency-blocked tasks
- "Show epics" → active epics with progress (`done/total`)
- "Task done: <id>" / "Mark task <id> complete" → set `status='done'`, `completed_at=NOW()`
- "Skip task: <id>" → set `status='cancelled'`
- "Add task: <description>" → create standalone task via detection rules
- "What's due today?" / "Today's priorities?" → due-today + P1 tasks
- "What can you do now?" / "Ready tasks?" → dependency-ready `auto_executable=TRUE`

**Response formatting (Telegram):**
- Use icons: ✅ done/completed, ⏳ in_progress, 🟢 ready, 🗓️ scheduled, 💤 backlog, 🔒 blocked, 🎯 epic, 📌 standalone
- Show task IDs, priorities (P1-P5), due dates when present, and `(auto)` for auto-executable tasks
- No markdown tables

## Task Board During Heartbeats

Check for ready auto-executable tasks and execute the highest priority one if time permits:
```sql
-- 1) Promote scheduled tasks that have reached execute time
UPDATE cortana_tasks
SET status = 'ready'
WHERE status = 'scheduled'
  AND execute_at IS NOT NULL
  AND execute_at <= NOW();

-- 2) Execute actionable tasks only
SELECT * FROM cortana_tasks 
WHERE status = 'ready' AND auto_executable = TRUE 
  AND (depends_on IS NULL OR NOT EXISTS (
    SELECT 1 FROM cortana_tasks t2 
    WHERE t2.id = ANY(cortana_tasks.depends_on) AND t2.status NOT IN ('done', 'completed')
  ))
ORDER BY priority ASC, created_at ASC LIMIT 1;
```

Also surface overdue `remind_at` tasks to Hamel:
```sql
SELECT * FROM cortana_tasks 
WHERE status = 'ready' AND remind_at <= NOW()
ORDER BY priority ASC;
```

Backlog policy: `status='backlog'` tasks are never auto-executed. Promote to `ready` only by explicit user request or Cortana judgment.

## Morning Brief Task View

Include task board status (epics + standalone + urgency + ready autos):
```sql
-- Active epics with progress
SELECT 
  e.title,
  e.deadline,
  COUNT(t.id) as total_tasks,
  COUNT(CASE WHEN t.status = 'done' THEN 1 END) as completed_tasks
FROM cortana_epics e
LEFT JOIN cortana_tasks t ON t.epic_id = e.id
WHERE e.status = 'active'
GROUP BY e.id, e.title, e.deadline
ORDER BY e.deadline ASC NULLS LAST;

-- Top standalone tasks (no epic)
SELECT title, priority, due_at, status FROM cortana_tasks
WHERE epic_id IS NULL 
  AND status IN ('ready', 'scheduled', 'in_progress')
ORDER BY priority ASC, due_at ASC NULLS LAST
LIMIT 5;

-- Overdue + due soon
SELECT id, title, due_at, priority,
  CASE
    WHEN due_at < NOW() THEN 'OVERDUE'
    WHEN due_at < NOW() + INTERVAL '24 hours' THEN 'DUE_TODAY'
    ELSE 'UPCOMING'
  END as urgency
FROM cortana_tasks
WHERE status IN ('ready', 'scheduled')
  AND due_at IS NOT NULL
  AND due_at <= NOW() + INTERVAL '48 hours'
ORDER BY due_at ASC;

-- Ready auto-executable count
SELECT COUNT(*) as ready_tasks FROM cortana_tasks
WHERE status = 'ready'
  AND auto_executable = TRUE
  AND (depends_on IS NULL OR NOT EXISTS (
    SELECT 1 FROM cortana_tasks t2
    WHERE t2.id = ANY(cortana_tasks.depends_on)
      AND t2.status NOT IN ('done', 'completed')
  ));
```
