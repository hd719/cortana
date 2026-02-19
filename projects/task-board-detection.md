# Task Board Detection Protocol

Auto-detection system for extracting actionable tasks and epics from conversations.

## Detection Triggers

### Direct Requests
**Patterns to catch:**
- `"Can you..."`
- `"Set up..."`
- `"Build..."`
- `"Fix..."`
- `"Research..."`
- `"Install..."`
- `"Configure..."`
- `"Write..."`
- `"Create..."`

**Action:** Extract as task, analyze for epic potential

### Implicit Tasks
**Patterns to catch:**
- `"We should..."`
- `"I need to..."`
- `"Don't forget to..."`
- `"TODO: ..."`
- `"Note to self:"`
- `"Later: ..."`
- `"Eventually: ..."`

**Action:** Convert to task with appropriate priority

### Multi-Step Work Detection
**Epic triggers (create epic + subtasks):**
- Lists with 2+ action items
- Planning language: `"prep for..."`, `"getting ready for..."`, `"before we..."` 
- Project language: `"migration"`, `"setup"`, `"overhaul"`, `"campaign"`
- Conditional chains: `"once X is done, then Y, then Z"`
- Time spans: `"over the next few days"`, `"this week we'll..."`

**Single task triggers:**
- One action item
- Quick fixes: `"quick fix"`, `"just need to..."`
- Single questions: `"what's the status of..."`

### Time-Based Detection
**Due dates (`due_at` field):**
- `"by Friday"` → next Friday
- `"before the trip"` → check calendar for travel, set day before
- `"this week"` → end of current week
- `"by [specific date]"` → parse date
- `"ASAP"` → today + high priority
- `"urgent"` → today + priority 1

**Reminders (`remind_at` field):**
- `"remind me to..."` → set remind_at based on context
- `"don't let me forget..."` → remind_at = 1 day before due_at or tomorrow if no due date
- `"check on this tomorrow"` → remind_at = tomorrow

## Auto-Classification Rules

### Priority Inference
```
Priority 1 (Urgent): "ASAP", "urgent", "critical", "now", "immediately"
Priority 2 (High): "soon", "this week", "important", "before Friday"  
Priority 3 (Normal): No urgency indicators, general requests
Priority 4 (Low): "when you get a chance", "eventually", "sometime"
Priority 5 (Later): "nice to have", "if there's time", "low priority"
```

### Auto-Executable Detection
```
auto_executable = TRUE:
- Research tasks
- File operations (read, write, edit, organize)  
- Git operations (commit, push, status, diff)
- Database queries and updates
- Code analysis and generation
- System checks (status, logs, health)
- Data gathering from APIs
- Document generation

auto_executable = FALSE:
- External communications (emails, tweets, messages to others)
- Financial transactions  
- Hardware operations
- Booking/purchasing
- Scheduling meetings with others
- Actions requiring human approval
```

### Epic vs Standalone Task Logic
```
CREATE EPIC if conversation contains:
- 2+ related action items
- Planning for event/trip/project
- Sequential dependencies mentioned
- Time span > 1 day implied
- Words: "project", "plan", "prep", "setup", "migration", "overhaul"

STANDALONE TASK if:
- Single action item
- Quick fix or check
- One-off request
- No dependencies mentioned
```

## SQL Templates

### Create Epic
```sql
INSERT INTO cortana_epics (title, source, status, deadline, metadata)
VALUES ('<title>', 'conversation', 'active', '<deadline_or_null>', '<context_json>');
```

### Create Task Under Epic  
```sql
INSERT INTO cortana_tasks (epic_id, title, description, priority, auto_executable, execution_plan, due_at, remind_at, source)
VALUES (<epic_id>, '<title>', '<details>', <1-5>, <true|false>, '<steps>', '<due_date>', '<remind_date>', 'conversation');
```

### Create Standalone Task
```sql
INSERT INTO cortana_tasks (title, description, priority, auto_executable, execution_plan, due_at, remind_at, source)
VALUES ('<title>', '<details>', <1-5>, <true|false>, '<steps>', '<due_date>', '<remind_date>', 'conversation');
```

### Set Dependencies (if mentioned)
```sql
UPDATE cortana_tasks SET depends_on = ARRAY[<task_id1>, <task_id2>] WHERE id = <dependent_task_id>;
```

## Example Extractions

### Example 1: Epic Detection
**Input:** *"We need to prep for the Mexico trip - check weather, make packing list, get international phone plan, and grab some pesos. Trip is next Friday."*

**Detection:** Multi-step work for event → CREATE EPIC

**Output:**
```sql
-- Epic
INSERT INTO cortana_epics (title, source, status, deadline, metadata)
VALUES ('Mexico Trip Prep', 'conversation', 'active', '2026-02-28', '{"context": "Trip preparation"}');

-- Subtasks
INSERT INTO cortana_tasks (epic_id, title, priority, auto_executable, due_at, source) VALUES
((SELECT id FROM cortana_epics WHERE title = 'Mexico Trip Prep'), 'Check weather in Mexico City', 3, true, '2026-02-26', 'conversation'),
((SELECT id FROM cortana_epics WHERE title = 'Mexico Trip Prep'), 'Generate packing list', 3, true, '2026-02-26', 'conversation'),
((SELECT id FROM cortana_epics WHERE title = 'Mexico Trip Prep'), 'Set up international phone plan', 2, false, '2026-02-27', 'conversation'),
((SELECT id FROM cortana_epics WHERE title = 'Mexico Trip Prep'), 'Get pesos/cash', 2, false, '2026-02-27', 'conversation');
```

### Example 2: Standalone Task
**Input:** *"Can you check if the watchdog service is running properly?"*

**Detection:** Single action, auto-executable → STANDALONE TASK

**Output:**
```sql
INSERT INTO cortana_tasks (title, description, priority, auto_executable, execution_plan, source)
VALUES ('Check watchdog service status', 'Verify watchdog service health and recent logs', 3, true, 'Use system tools to check service status, recent logs, and runtime metrics', 'conversation');
```

### Example 3: Reminder Task
**Input:** *"Remind me to follow up on the OpenAI API application tomorrow"*

**Detection:** Explicit reminder request → TASK with remind_at

**Output:**
```sql
INSERT INTO cortana_tasks (title, priority, auto_executable, remind_at, source)
VALUES ('Follow up on OpenAI API application', 3, false, '2026-02-20 09:00:00', 'conversation');
```

## Integration Points

### Conversation Analysis (in main session)
After each conversation turn, scan for detection patterns and extract tasks/epics. Log to database immediately.

### Morning Brief Integration  
Surface newly created tasks and epics from conversations in the previous 24 hours.

### Heartbeat Execution
Check for auto-executable tasks that are now ready (dependencies met, execute_at reached).

## Error Handling
- If epic/task creation fails, log to cortana_events table
- Duplicate detection: check for similar titles in past 7 days before inserting
- Invalid dates: default to reasonable fallbacks (end of week, tomorrow, etc.)
- Ambiguous priority: default to 3 (normal)