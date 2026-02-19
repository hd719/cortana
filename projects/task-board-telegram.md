# Task Board - Telegram UI Commands

Natural language commands for interacting with Cortana's task board via Telegram.

## Board View Commands

### "Show me tasks" / "What's on the board?"
Display current board state with epics and standalone tasks.

**Response Format (Telegram-friendly, no markdown tables):**
```
📋 Task Board

🎯 Epic: Mexico Trip Prep (3/5 done) 
  ✅ Check weather
  ✅ Packing list  
  ⏳ International phone plan (P2)
  🔒 Book flight confirmations (P1, blocked: waiting on email)
  ❌ Get pesos/cash (P2)

🎯 Epic: OpenAI Migration (1/5 done)
  ✅ Re-auth Codex CLI
  ⏳ Switch primary model (P2)
  ❌ Update embeddings (P3)
  ❌ Test sub-agent model (P3, auto)
  ❌ Run 48h test cycle (P3, auto)

📌 Standalone Tasks
  ⏳ HW 597 assignment (P2, due Mar 4)
  ✅ Fix watchdog script
  ❌ Review budget dashboard (P4)

🔒 Blocked Tasks
  🔒 Deploy fitness cache (P2, waiting on: PR review)
  🔒 Book Mexico flights (P1, waiting on: email confirmation)
```

**Status Icons:**
- ✅ = done
- ⏳ = in progress  
- ❌ = pending
- 🔒 = blocked
- 🎯 = epic header
- 📌 = standalone section

**Priority Display:** `(P1)` through `(P5)` where P1 = urgent, P5 = low
**Auto-executable:** Show `(auto)` for tasks Cortana can do without approval
**Due dates:** Show `(due Mar 4)` for approaching deadlines
**Dependencies:** Show `(waiting on: X)` for blocked tasks

### "What's blocked?" 
Show only tasks with unmet dependencies.

**Query:**
```sql
SELECT t.id, t.title, t.priority, t.depends_on, e.title as epic_title
FROM cortana_tasks t
LEFT JOIN cortana_epics e ON t.epic_id = e.id
WHERE t.status != 'done' 
  AND t.depends_on IS NOT NULL 
  AND EXISTS (
    SELECT 1 FROM cortana_tasks t2 
    WHERE t2.id = ANY(t.depends_on) AND t2.status != 'done'
  );
```

### "Show epics"
List active epics with progress summary.

**Response Format:**
```
🎯 Active Epics

Mexico Trip Prep (3/5 done) - due Feb 28
OpenAI Migration (1/5 done)  
Website Redesign (0/8 done) - due Mar 15
```

## Task Management Commands

### "Task done: <id>" 
Mark specific task as complete.

**Examples:**
- "Task done: 42"
- "Mark task 15 complete"  
- "Task 23 is finished"

**Action:**
```sql
UPDATE cortana_tasks 
SET status = 'done', completed_at = NOW() 
WHERE id = <id>;
```

**Response:** "✅ Task #42 marked complete: [task title]"

### "Add task: <description>"
Create new standalone task from message.

**Examples:**
- "Add task: Review Q1 budget numbers"
- "Create task: Follow up with dentist office"

**Detection:** Extract priority, due dates, auto-executable status from description
**Action:** Insert new task using detection protocol
**Response:** "📝 Created task #45: [title] (P3, auto)"

### "Skip task: <id>" / "Task skip: <id>"
Defer task (status = 'cancelled', keep for reference).

**Response:** "⏭️ Task #42 skipped: [task title]"

## Inline Buttons

When displaying task lists, include interactive buttons using the message tool:

**Button Configuration:**
```javascript
buttons = [
  [
    {"text": "✅ Done", "callback_data": "task_done_<id>"},
    {"text": "⏭️ Skip", "callback_data": "task_skip_<id>"}
  ],
  [
    {"text": "🔄 Reprioritize", "callback_data": "task_repri_<id>"},
    {"text": "📝 Details", "callback_data": "task_detail_<id>"}
  ]
]
```

**Callback Data Handlers:**
- `task_done_<id>` → Mark task complete
- `task_skip_<id>` → Skip/cancel task
- `task_repri_<id>` → Show priority options (P1-P5)
- `task_detail_<id>` → Show full task details + edit options

**Implementation Example:**
```python
# When sending board view
message(
  action='send',
  target='telegram_chat_id',
  message=board_text,
  buttons=[[
    {"text": "✅ Done", "callback_data": f"task_done_{task_id}"},
    {"text": "⏭️ Skip", "callback_data": f"task_skip_{task_id}"}
  ] for task_id in displayed_tasks]
)
```

## Epic Management Commands

### "Create epic: <title>"
Start new epic/project.

**Examples:**
- "Create epic: Q2 Planning"
- "New epic: Home Office Setup"

**Action:** Create epic with 'active' status, prompt for initial tasks

### "Epic done: <title or id>"  
Mark entire epic as completed.

**Action:** 
- Mark epic status = 'completed'
- Mark all associated tasks as 'done' or 'cancelled'

### "Add to epic <id>: <task description>"
Add task to existing epic.

**Example:** "Add to epic Mexico Trip: Book return Uber from EWR"

## Quick Actions

### "What's due today?" / "Today's priorities?"
Show tasks due today or marked urgent.

**Query:**
```sql
SELECT id, title, priority, due_at, epic_id FROM cortana_tasks
WHERE status = 'pending' 
  AND (due_at::date = CURRENT_DATE OR priority = 1)
ORDER BY priority ASC, due_at ASC;
```

### "What can you do now?" / "Ready tasks?"
Show auto-executable tasks with no dependencies.

**Query:**
```sql  
SELECT id, title, description FROM cortana_tasks
WHERE status = 'pending' 
  AND auto_executable = TRUE
  AND (depends_on IS NULL OR NOT EXISTS (
    SELECT 1 FROM cortana_tasks t2 
    WHERE t2.id = ANY(cortana_tasks.depends_on) AND t2.status != 'done'
  ));
```

## Morning Brief Integration

Include task board summary in daily morning brief:

**Section Format:**
```
📋 Task Board Status
• 2 epics active (Mexico Trip: 3/5, Migration: 1/5)
• 8 pending tasks (3 ready, 2 blocked, 3 scheduled)  
• 1 overdue: HW 597 assignment (due yesterday)
• Next auto: Switch primary model to Codex (P2)
```

## Error Handling

**Invalid task ID:**
"❌ Task #99 not found. Use 'show me tasks' to see current IDs."

**Already completed:**
"✅ Task #42 is already marked complete."

**Permission required:**  
"🔒 Task #42 requires approval - not auto-executable. Mark done manually when complete."

**Ambiguous command:**
"📋 Multiple tasks found. Please specify task ID or be more specific."

## Implementation Notes

### Database Queries
All commands should use PostgreSQL queries against `cortana_tasks` and `cortana_epics` tables.

### Response Formatting
- Keep responses concise for Telegram
- Use emojis for visual clarity
- No markdown tables (bullets/indentation instead)
- Include task IDs for easy reference
- Show priority and status indicators consistently

### Button State Management
- Buttons should update/remove after use
- Show confirmation messages after button actions
- Handle concurrent button presses gracefully

### Auto-refresh
- After task state changes, offer to show updated board
- Include "🔄 Refresh board" button in responses
- Cache board state briefly to avoid repeated DB queries