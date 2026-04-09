# Agent Accountability Playbook

A practical, end-to-end guide for implementing a trustworthy AI agent that *proves* what it did, learns from corrections, and never silently drops work.

This playbook is designed to be self-contained:
- You can drop it into any codebase as the blueprint for an accountability layer.
- It includes schemas, patterns, and example queries.
- It assumes a PostgreSQL primary, with notes for SQLite.

---

## 1. Core System Prompt (Include Verbatim)

This is the behavioral contract for your agent. It encodes how it must treat tasks, delivery, feedback, and reflection.

You should:
- Embed this into the agent’s system prompt / high-priority instructions.
- Keep it versioned in your repo.
- Treat changes to it like changes to application code (review, test, rollout).

**System Prompt:**

```
## Accountability Protocol

You are an autonomous agent. Autonomy without accountability is a liability. Follow these rules:

### 1. Task Database (Never trust context memory alone)
- Every task goes into a persistent database table, not just your context window.
- Schema minimum: id, title, status, created_at, completed_at, outcome
- Valid statuses: backlog → scheduled → ready → in_progress → completed/failed
- Status updates are ATOMIC: update the DB the moment work starts AND when it finishes.
- If you say "I'll do X" but don't have a task row to prove it → you didn't commit to it.

### 2. Launch Verification (No phantom launches)
- Never claim you started something without proof (a run ID, process ID, or DB row).
- Action first, message second. If a launch fails, report failure — never imply success.

### 3. Delivery ≠ Execution
- Running a task successfully means NOTHING if the human didn't receive the result.
- After every task completion: verify the output was actually delivered to the human's channel.
- Monitor delivery status, not just execution status.
- If delivery fails → retry via explicit channel send, then alert.

### 4. Feedback Loop (Corrections become guardrails)
- Maintain a feedback table: timestamp, feedback_type, context, lesson, applied (boolean)
- Every time the human corrects you → log it immediately.
- On session start, review recent unprocessed feedback.
- Periodically create prevention tasks from recurring correction patterns.
- Corrections are training data, not shame.

### 5. Reflection Sweeps (Daily self-audit)
- Once daily, ask: "What went wrong? What's the pattern? What prevents recurrence?"
- Log patterns to the database so you can see themes across days.
- If the same mistake happens twice → escalate the rule to a HARD RULE.
- If a hard rule is violated → create an automated check that catches it.

### 6. Sub-Agent Accountability (If you delegate)
- Every sub-agent launch must have: a label, a task ID, and a completion callback.
- When a sub-agent completes → update the task DB immediately.
- If a sub-agent goes silent for >10 minutes → check on it and escalate.
- Summarize sub-agent results for the human (≤10 words). Details go to logs.

### 7. Proactive Reporting (Never go dark)
- If you're working on something that takes >2 minutes → send a progress indicator.
- If you hit a blocker → report immediately, don't silently retry forever.
- If you complete work → confirm to the human. Silence after "I'll do X" is a failure.

### 8. The Golden Rule
- The human should NEVER have to ask "did you do that thing?"
- If they're asking, your accountability system failed.
```

---

## 2. Data Model: SQL Schemas

This section defines the core tables required to implement the protocol. They are designed for PostgreSQL, with brief notes for SQLite.

At minimum you need:
- A **tasks** table — to track all work across its lifecycle.
- A **feedback** table — to capture corrections and preferences.
- A **patterns** table — to store reflections and recurring themes.
- A **decision traces** table — to audit autonomous actions.
- An **events** table — to log system-level events and alerts.

### 2.1 Tasks Table — Full Lifecycle Support

**PostgreSQL:**

```sql
CREATE TABLE agent_tasks (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT DEFAULT 'conversation',  -- where the task came from
  title TEXT NOT NULL,
  description TEXT,
  priority INTEGER DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),  -- 1=critical, 5=low
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('backlog','scheduled','ready','in_progress','completed','failed','cancelled')),
  due_at TIMESTAMPTZ,
  execute_at TIMESTAMPTZ,  -- for scheduled tasks: when to auto-execute
  auto_executable BOOLEAN DEFAULT FALSE,  -- can the agent run this without human approval?
  execution_plan TEXT,
  depends_on INTEGER REFERENCES agent_tasks(id),
  completed_at TIMESTAMPTZ,
  outcome TEXT,
  metadata JSONB DEFAULT '{}'
);
```

**SQLite Notes:**
- Use `INTEGER PRIMARY KEY AUTOINCREMENT` instead of `SERIAL`.
- Replace `TIMESTAMPTZ` with `TEXT` containing ISO-8601 strings, or `INTEGER` epoch ms.
- Remove `CHECK` constraints if your SQLite version or migration tool doesn’t support them well.
- Use `metadata TEXT` storing JSON, or a separate table for key/value metadata.

Example SQLite variant:

```sql
CREATE TABLE agent_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT DEFAULT 'conversation',
  title TEXT NOT NULL,
  description TEXT,
  priority INTEGER DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'ready',
  due_at TEXT,
  execute_at TEXT,
  auto_executable INTEGER DEFAULT 0,
  execution_plan TEXT,
  depends_on INTEGER,
  completed_at TEXT,
  outcome TEXT,
  metadata TEXT DEFAULT '{}'
);
```

### 2.2 Feedback Table — Corrections Become Rules

**PostgreSQL:**

```sql
CREATE TABLE agent_feedback (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  feedback_type TEXT NOT NULL DEFAULT 'correction',  -- correction, preference, approval, rejection
  context TEXT NOT NULL,  -- what happened
  lesson TEXT NOT NULL,  -- what to do differently
  applied BOOLEAN DEFAULT FALSE  -- has this been wired into prevention?
);
```

**SQLite:**

```sql
CREATE TABLE agent_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  feedback_type TEXT NOT NULL DEFAULT 'correction',
  context TEXT NOT NULL,
  lesson TEXT NOT NULL,
  applied INTEGER DEFAULT 0
);
```

### 2.3 Patterns Table — Behavioral Tracking

**PostgreSQL:**

```sql
CREATE TABLE agent_patterns (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pattern_type TEXT NOT NULL,  -- reflection, routine, error_pattern
  value TEXT NOT NULL,
  day_of_week INTEGER,
  metadata JSONB DEFAULT '{}'
);
```

**SQLite:**

```sql
CREATE TABLE agent_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  pattern_type TEXT NOT NULL,
  value TEXT NOT NULL,
  day_of_week INTEGER,
  metadata TEXT DEFAULT '{}'
);
```

### 2.4 Decision Traces Table — Audit Trail of Autonomous Actions

**PostgreSQL:**

```sql
CREATE TABLE agent_decision_traces (
  id SERIAL PRIMARY KEY,
  trace_id TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
  task_id INTEGER REFERENCES agent_tasks(id),
  trigger_type TEXT NOT NULL,  -- heartbeat, user_request, cron, auto_executor
  action_type TEXT NOT NULL,  -- email_check, task_execution, cron_delivery, etc.
  action_name TEXT NOT NULL,
  reasoning TEXT,  -- WHY this action was taken
  confidence NUMERIC(5,4),  -- 0.0000 to 1.0000
  outcome TEXT NOT NULL DEFAULT 'unknown',  -- success, fail, skipped, unknown
  data_inputs JSONB DEFAULT '{}',  -- what signals drove this decision
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
```

**SQLite:**

```sql
CREATE TABLE agent_decision_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL UNIQUE,
  task_id INTEGER,
  trigger_type TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_name TEXT NOT NULL,
  reasoning TEXT,
  confidence REAL,
  outcome TEXT NOT NULL DEFAULT 'unknown',
  data_inputs TEXT DEFAULT '{}',
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
```

For SQLite, generate `trace_id` in application code (UUID string) instead of `gen_random_uuid()`.

### 2.5 Events Table — System Event Logging

**PostgreSQL:**

```sql
CREATE TABLE agent_events (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',  -- info, warning, error, critical
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'
);
```

**SQLite:**

```sql
CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  metadata TEXT DEFAULT '{}'
);
```

---

## 3. The Feedback Loop Playbook

An accountable agent doesn’t just “avoid errors”; it *learns* from them and hardens its behavior over time.

This section describes the full learning loop: **Capture → Prevent → Reflect → Verify**.

### Step 1: Capture — Log Corrections Immediately

Whenever the human corrects the agent (or the system detects a mistake), you:

1. **Log a feedback row** in `agent_feedback` with:
   - `feedback_type`: `correction`, `preference`, `approval`, or `rejection`.
   - `context`: a short description of what happened (what was asked, what the agent did).
   - `lesson`: what should happen next time instead.
   - `applied`: `FALSE` until prevention is wired in.

2. **Acknowledge the learning** to the human channel:
   - Briefly restate the lesson in your own words.
   - Confirm that it’s logged and will influence future behavior.

**Example:**
- Human: “Don’t summarize my emails on weekends unless I explicitly ask.”
- Feedback row:
  - `feedback_type = 'preference'`
  - `context = 'Weekend email digest was sent automatically.'`
  - `lesson = 'Disable weekend auto-email summaries unless user explicitly requests.'`
  - `applied = FALSE`

This creates a durable trace of the correction instead of relying on context memory.

### Step 2: Prevent — Turn Corrections into Guardrails

Each feedback item should trigger a prevention action. The type of action depends on what the feedback is about:

1. **Preferences → Memory / Config**
   - Store user preferences in a config table/file or long-term memory.
   - Make sure your prompt and behavior read from this store.
   - Example: “Never send Slack DMs after 9pm local time” → stored as a quiet-hours preference.

2. **Behaviors → System Prompt Rules**
   - If a correction changes how the agent should operate *in general*, update the system prompt or an auxiliary rules file.
   - Example: “Always log tasks to `agent_tasks` before saying ‘I’ll do X’.”

3. **Patterns → Automated Checks**
   - When similar corrections occur multiple times (same `lesson` or theme), create an automated check or linter.
   - Examples:
     - A cron that scans for tasks stuck `in_progress` for > N minutes.
     - A guard that blocks sending network messages without logging a `decision_trace` first.

4. **Create a Prevention Task**
   - For anything non-trivial, add a task into `agent_tasks` to implement the prevention mechanism.
   - Link to the relevant feedback via `metadata` (e.g., `{ "feedback_ids": [1, 3, 7] }`).

Once the prevention mechanism is in place and deployed, set `applied = TRUE` for the associated feedback rows.

### Step 3: Reflect — Daily Sweep

At least once per day, run a “reflection sweep” that looks at recent feedback and patterns:

1. **Query unapplied feedback:**
   - `SELECT * FROM agent_feedback WHERE applied = FALSE ORDER BY timestamp;`
   - Review each row and decide: does this require a new rule, config, or check?

2. **Cluster by lesson or theme:**
   - Group feedback rows by similar `lesson` content.
   - When the same lesson appears more than once, treat it as a systemic issue.

3. **Escalate to HARD RULES:**
   - If a mistake has occurred at least twice, elevate the countermeasure:
     - Add an explicit rule under a “HARD RULES” section in your system prompt.
     - Add automated checks in your runtime where possible.

4. **Log patterns:**
   - Insert a row into `agent_patterns` with:
     - `pattern_type = 'reflection'` or `'error_pattern'`.
     - `value`: short description of the pattern (e.g., “Tasks frequently marked completed without delivery verification”).
     - `day_of_week`: for spotting weekday patterns.

5. **Mark applied feedback:**
   - Once a correction has been addressed by:
     - Updating prompts or config, *and*
     - Implementing checks/automation (if needed),
   - Update the corresponding `agent_feedback.applied` to `TRUE`.

### Step 4: Verify — Prove the System Works

To trust your agent, you need evidence that:

- Every autonomous action is traceable.
- Tasks aren’t silently dropped.
- Corrections lead to behavior changes.

Use three kinds of evidence:

1. **Decision Traces (`agent_decision_traces`)**
   - For each autonomous action (cron, auto-executor, background task), log:
     - What triggered it (`trigger_type`).
     - What it did (`action_type`, `action_name`).
     - Why (`reasoning`, `data_inputs`).
     - How confident it was (`confidence`).
     - What happened (`outcome`).
   - This lets you answer: *“Why did the agent do X at 03:14?”*

2. **Task DB (`agent_tasks`)**
   - For each commitment the agent makes (“I’ll do X”), there’s a task row.
   - Status transitions show progress over time.
   - `completed_at` and `outcome` show when and how it finished (or failed).

3. **Feedback Table (`agent_feedback`)**
   - Shows that corrections are both logged and processed.
   - `applied = FALSE` rows highlight outstanding improvements.
   - Over time, you should see:
     - New feedback rates drop.
     - More feedback marked as `applied`.
     - Fewer repeat mistakes in `agent_patterns`.

---

## 4. Delivery Verification Pattern

### The Problem

Cron jobs and scheduled tasks often run in the background, log `status: ok`, and then vanish. If the final step — delivering the result to the human — fails, the system quietly rots:

- The cron process exits successfully.
- The agent thinks the work is done.
- The human never sees the output.

This creates a dangerous illusion of reliability.

### The Principle

**Execution success is not enough. You must verify delivery success.**

A robust pattern requires checking *two* things for each task:

1. **Execution status** — Did the underlying job run without error?
2. **Delivery status** — Did the human actually receive the result (message, email, notification) in the intended channel?

### How to Implement Delivery Verification

1. **Model delivery as part of the task lifecycle**
   - Extend `agent_tasks.metadata` to track delivery:

   ```json
   {
     "execution_status": "success|fail",
     "delivery_status": "pending|success|fail",
     "delivery_channel": "telegram|email|web|cli",
     "delivery_message_id": "...",
     "last_delivery_attempt_at": "2026-02-26T15:00:00Z",
     "delivery_attempts": 1
   }
   ```

2. **After executing a task:**
   - Mark execution outcome in `agent_tasks`:
     - `status = 'completed'` or `'failed'`.
     - `completed_at = NOW()`.
     - `outcome` includes a short summary of what happened.
   - Then attempt to deliver the result.

3. **Verify delivery explicitly:**
   - Use the messaging API’s response as a source of truth (e.g., message ID, HTTP 200, or API-level delivery status).
   - If the send call fails or returns a non-success response:
     - Set `delivery_status = 'fail'` in metadata.
     - Log an `agent_events` row with severity `warning` or `error`.

4. **Retry then alert:**
   - If `delivery_status = 'fail'` and `delivery_attempts < N` (e.g., 3):
     - Schedule a retry via a new task or a retry loop with backoff.
   - If retries are exhausted:
     - Log a critical event in `agent_events`.
     - Consider using an alternate channel (e.g., email instead of chat) if available.

5. **Monitor for undelivered results:**
   - A periodic job queries for tasks where:

   ```sql
   status = 'completed' AND
   (metadata->>'delivery_status' IS NULL OR metadata->>'delivery_status' != 'success');
   ```

   - Any row returned is a “ghost completion” — executed but not delivered.
   - The job should:
     - Attempt a new delivery.
     - Or escalate (alert a human) if automatic delivery is not possible.

### Why This Matters

Without delivery verification, a task system is inherently deceptive:

- Logs say “all good”.
- The human experience is “where the hell is my stuff?”.
- You lose trust, which is much harder to rebuild than it is to preserve.

Delivery verification closes that loop and makes your automation trustworthy.

---

## 5. Implementation Order

To avoid over-engineering and to get value quickly, implement in this order:

### 1. Task DB First — Nothing Lives Only in Context

- Create `agent_tasks` (Postgres or SQLite).
- Make the agent write *every* task it commits to into this table.
- Enforce that status changes are atomic and timely:
  - When work starts → `status = 'in_progress'`.
  - When work finishes → `status = 'completed'` or `'failed'`, `completed_at`, `outcome`.

This immediately gives you:
- A backlog of everything the agent promised to do.
- A way to see stuck or forgotten tasks.

### 2. Feedback Table Second — Start Logging Corrections Day One

- Create `agent_feedback`.
- Wire the agent so that any explicit human correction creates a row.
- Even before you build full reflection automation, this gives you auditability:
  - “What did the human complain about this week?”
  - “What recurring themes are showing up in corrections?”

### 3. Delivery Verification Third — Hardest but Highest Impact

- Add delivery fields to `agent_tasks.metadata`.
- Build a lightweight delivery verification job:
  - Check for completed tasks with missing or failed delivery.
  - Retry or alert.

This is where reliability really jumps, because it closes the loop between “job ran” and “human saw it”.

### 4. Decision Traces Fourth — Build an Audit Trail

- Create `agent_decision_traces`.
- For each autonomous action (cron, auto-executor, background agent):
  - Insert a trace row at start of execution.
  - Update it with outcome and `completed_at` when done.

This enables:
- Post-mortems (“Why did the agent do X?”).
- Safety audits (“What did the agent do overnight?”).
- Explainability for stakeholders.

### 5. Reflection Sweeps Last — Once You Have Data

- Implement daily reflection scripts or cron-based sweeps that:
  - Query `agent_feedback` for unapplied corrections.
  - Query `agent_patterns` for recurring error patterns.
  - Generate new tasks to address systemic issues.

Reflection is powerful but only once the other layers are generating rich data.

---

## 6. Quick Reference Commands & Queries

Use this section as a cheat sheet when operating or debugging the system.

> **Note:** Adjust table names / schemas as needed for your environment.

### 6.1 View Pending Tasks

**PostgreSQL:**

```sql
-- Tasks that are not yet completed or failed
SELECT
  id,
  created_at,
  title,
  status,
  priority,
  due_at,
  execute_at
FROM agent_tasks
WHERE status IN ('backlog','scheduled','ready','in_progress')
ORDER BY
  CASE status
    WHEN 'in_progress' THEN 0
    WHEN 'ready' THEN 1
    WHEN 'scheduled' THEN 2
    WHEN 'backlog' THEN 3
    ELSE 4
  END,
  priority ASC,
  created_at ASC;
```

**SQLite:** same query, minus any Postgres-specific JSON expressions.

### 6.2 Log a Correction (Feedback Row)

**PostgreSQL / SQLite (parameterized from application code):**

```sql
INSERT INTO agent_feedback (feedback_type, context, lesson)
VALUES ($1, $2, $3);
```

Example values:
- `$1 = 'correction'`
- `$2 = 'Agent sent duplicate daily summary at 8am.'`
- `$3 = 'Before sending summary, check if one has already been sent today.'`

### 6.3 Run a Reflection Sweep (Conceptual Flow)

**1. Pull unapplied feedback:**

```sql
SELECT id, timestamp, feedback_type, context, lesson
FROM agent_feedback
WHERE applied = FALSE
ORDER BY timestamp ASC;
```

**2. Mark feedback as applied once prevention is implemented:**

```sql
UPDATE agent_feedback
SET applied = TRUE
WHERE id = ANY($1::int[]);
```

(For SQLite, just loop over IDs and run `UPDATE` with `WHERE id IN (...)`.)

**3. Log a reflection pattern:**

```sql
INSERT INTO agent_patterns (pattern_type, value, day_of_week, metadata)
VALUES (
  'reflection',
  'Repeated corrections about missing delivery verification for scheduled reports',
  EXTRACT(DOW FROM NOW()),
  '{"category":"delivery","severity":"high"}'::jsonb
);
```

For SQLite, store `day_of_week` and `metadata` from application code:

```sql
INSERT INTO agent_patterns (pattern_type, value, day_of_week, metadata)
VALUES ('reflection', ?, ?, ?);
```

### 6.4 Check for Undelivered Results

Assuming delivery metadata is stored as JSON in `metadata` (Postgres):

```sql
-- Completed tasks where delivery has not succeeded
SELECT
  id,
  title,
  completed_at,
  outcome,
  metadata->>'delivery_status' AS delivery_status,
  metadata->>'delivery_channel' AS delivery_channel
FROM agent_tasks
WHERE status = 'completed'
  AND (
    metadata->>'delivery_status' IS NULL
    OR metadata->>'delivery_status' != 'success'
  )
ORDER BY completed_at DESC;
```

In SQLite (with `metadata` as TEXT), perform JSON parsing in application code, or use an extension like `json1` if available:

```sql
-- Using SQLite json1 extension (if enabled)
SELECT
  id,
  title,
  completed_at,
  outcome,
  json_extract(metadata, '$.delivery_status') AS delivery_status,
  json_extract(metadata, '$.delivery_channel') AS delivery_channel
FROM agent_tasks
WHERE status = 'completed'
  AND (
    json_extract(metadata, '$.delivery_status') IS NULL
    OR json_extract(metadata, '$.delivery_status') != 'success'
  )
ORDER BY completed_at DESC;
```

### 6.5 View Decision Timeline for a Task or Period

**Timeline for a specific task:**

```sql
SELECT
  trace_id,
  trigger_type,
  action_type,
  action_name,
  reasoning,
  confidence,
  outcome,
  created_at,
  completed_at
FROM agent_decision_traces
WHERE task_id = $1
ORDER BY created_at ASC;
```

**All decisions within a time window:**

```sql
SELECT
  trace_id,
  task_id,
  trigger_type,
  action_type,
  action_name,
  outcome,
  created_at,
  completed_at
FROM agent_decision_traces
WHERE created_at BETWEEN $1 AND $2
ORDER BY created_at ASC;
```

This lets you reconstruct what the agent did and in what order, which is crucial for debugging and trust.

---

## 7. Bringing It All Together

If you implement this playbook end-to-end, you get:

- A **Task DB** that proves what was promised and what actually happened.
- A **Feedback Loop** that turns corrections into guardrails instead of repeating mistakes.
- **Delivery Verification** so users never wonder whether a job actually landed.
- **Decision Traces** that let you audit and explain autonomous behavior.
- **Reflection Sweeps** that continuously harden the system over time.

The north star is simple:

> The human should never have to ask, “Did you do that thing?”

If they do, check your task DB, feedback loop, delivery verification, and traces — then upgrade the system so they don’t have to ask again.