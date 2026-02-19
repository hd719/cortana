# Morning Brief Cron - Task Board Integration

Documentation for updating morning brief cron (job id: 489b1e20-1bb0-48e6-a388-c3cc1743a324) to include task board summary.

## Current Morning Brief Structure
The morning brief follows this structure:
1. Weather
2. Calendar  
3. Fitness
4. Portfolio
5. Section H: Various daily checks
6. News/alerts

## New Task Board Section

Add this as **Step 5 section H (Tasks)** in the morning brief prompt:

```
H. Task Board Summary
Query the task board and include progress on active work:

-- Active epics with progress and deadlines
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

-- Top priority standalone tasks (no epic)
SELECT title, priority, due_at, status FROM cortana_tasks
WHERE epic_id IS NULL 
  AND status IN ('pending', 'in_progress')
ORDER BY priority ASC, due_at ASC NULLS LAST
LIMIT 5;

-- Overdue tasks and approaching deadlines
SELECT id, title, due_at, priority, 
  CASE 
    WHEN due_at < NOW() THEN 'OVERDUE'
    WHEN due_at < NOW() + INTERVAL '24 hours' THEN 'DUE_TODAY' 
    ELSE 'UPCOMING'
  END as urgency
FROM cortana_tasks
WHERE status = 'pending' 
  AND due_at IS NOT NULL 
  AND due_at <= NOW() + INTERVAL '48 hours'
ORDER BY due_at ASC;

-- Ready auto-executable tasks
SELECT COUNT(*) as ready_tasks FROM cortana_tasks
WHERE status = 'pending' 
  AND auto_executable = TRUE
  AND (depends_on IS NULL OR NOT EXISTS (
    SELECT 1 FROM cortana_tasks t2 
    WHERE t2.id = ANY(cortana_tasks.depends_on) 
    AND t2.status != 'done'
  ));

Format the task board summary like:

📋 Task Board
• 2 active epics: Mexico Trip (3/5 done, due Feb 28), OpenAI Migration (1/5 done)
• 8 pending tasks (3 high priority, 2 ready for auto-execution)
• ⚠️ 1 overdue: HW 597 assignment (due yesterday)  
• 🎯 Today's focus: International phone plan, Switch primary model

If no active tasks: "📋 Task board clear - no pending work"
```

## Integration Points

### Epic Deadline Alerts
If any epic has deadline within 48h with incomplete tasks, highlight in the brief:
"🚨 Epic 'Mexico Trip Prep' deadline in 36 hours - 2/5 tasks remaining"

### Auto-execution Preview  
Include count of tasks ready for auto-execution:
"🤖 3 tasks ready for auto-execution during today's heartbeats"

### Reminder Surfacing
Check for tasks with `remind_at <= NOW()` and surface them:
"📝 Reminders: Follow up on OpenAI API application"

## Implementation Notes

### Database Connection
Morning brief should connect to PostgreSQL using:
```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana -c "SELECT ..."
```

### Error Handling
If task board queries fail, show:  
"📋 Task board: (query error - check database connection)"

### Formatting Guidelines  
- Keep task board section concise (3-4 lines max)
- Use emojis for visual separation
- Prioritize overdue/urgent items
- Show epic progress as fractions (3/5 done)
- Include deadlines for context

## Example Output

```
📋 Task Board
• 2 active epics: Mexico Trip (3/5 done, due Feb 28), OpenAI Migration (1/5 done)  
• 4 pending standalone tasks (2 high priority)
• 🤖 3 tasks ready for auto-execution
• 🎯 Today's priorities: International phone plan (P2), Review budget (P4)
```

Or if board is clear:
```
📋 Task board clear - no pending work
```

## Cron Job Update Process

**DO NOT apply this directly.** The main agent will update the morning brief cron prompt separately using:
```bash
openclaw cron update 489b1e20-1bb0-48e6-a388-c3cc1743a324 --prompt "[updated prompt with task board section]"
```

This document serves as the specification for what that update should include.