# HEARTBEAT.md

Rotating checks for heartbeat polls. Pick 1-2 per heartbeat based on staleness.
Track last check times in `memory/heartbeat-state.json`.

## Check Rotation

### Email Triage (2-3x daily)
- Run `tools/gmail/email-triage-autopilot.sh` (minimal query, no outbound sends)
- Auto-create tasks for urgent/action emails in `cortana_tasks`
- Send/prepare Telegram digest only (guardrail: no external email sends)
- Skip if checked within last 4 hours

### Calendar Lookahead (2x daily)
- Events in next 24-48 hours
- Conflicts or prep needed?
- Skip if checked within last 6 hours

### Portfolio Alerts (1-2x daily, market hours only)
- Big movers in watchlist (>3% change)
- Earnings surprises
- Use Alpaca service on port **3033** (no web search needed):
  - Portfolio: `curl -s http://localhost:3033/alpaca/portfolio | jq '.positions[] | {symbol, market_value, unrealized_plpc}'`
  - Stats: `curl -s http://localhost:3033/alpaca/stats`
- Skip weekends and after-hours

### Fitness Check-in (1x daily, morning)
- Whoop recovery score
- Workout scheduled?
- Skip if already briefed today

### Weather (1x daily, morning)
- Warren NJ forecast
- Anything notable (rain, extreme temps)?

### API Budget Check (weekly, or if usage seems high)
- Always run fresh: `node /Users/hd/clawd/skills/telegram-usage/handler.js json` (pulls live `clawdbot models status`, no caching)
- If `~/.openclaw/quota-tracker.json` looks stale/corrupt (older than ~4h or bad data), delete it first, then rerun the command
- Check percentage of $100 monthly budget used
- If >50% before mid-month → alert
- If >75% any time → alert with recommendation to throttle

### Tech News — Critical Tools (2x daily, afternoon + evening)
- Quick search for breaking news on: OpenClaw, Anthropic, OpenAI, tools we rely on
- Sources: TechCrunch, Hacker News front page, web search
- Alert immediately if: acquisitions, shutdowns, major security issues, breaking changes
- Morning brief catches AM news; this catches PM breaking news
- Skip if checked within last 4 hours

### Mission Advancement (1x daily, evening)
- Reverse-prompt: "What is 1 task we can do right now to get closer to our mission statement?"
- Consider all four pillars: Time, Health, Wealth, Career
- If the task is auto-executable, add it to cortana_tasks
- If it needs approval, surface it to Hamel in the next check-in
- Skip if already proposed a mission task today

### Unified Memory Ingestion (1-2x daily)
- Run: `python3 /Users/hd/clawd/tools/memory/ingest_unified_memory.py --since-hours 24`
- Purpose: keep episodic/semantic/procedural memory tables fresh
- Skip if already run in past 12 hours and no major new corrections/events

### Reflection Sweep (1x daily, evening)
- Run automated reflection + correction loop:
  - `python3 /Users/hd/clawd/tools/reflection/reflect.py --mode sweep --trigger-source heartbeat --window-days 30`
- Purpose: post-task reflections, confidence-scored rule extraction, policy auto-apply, repeated-correction KPI
- If repeated correction rate rises (>25%), alert Hamel and propose stronger rule wording
- Skip if already run in the last 12 hours

---

## 🔮 Proactive Intelligence

### System Health (every heartbeat)
- Run cron quality gate where relevant: `tools/alerting/cron-preflight.sh <cron_name> <checks...>` before high-value cron work
- Quarantine failing crons via `~/.openclaw/cron/quarantine/*.quarantined`; watchdog surfaces these automatically
Query watchlist and auto-heal or alert:
```sql
SELECT * FROM cortana_watchlist WHERE enabled = TRUE;
```

**Auto-heal checks:**
- Session files >400KB (path: `~/.openclaw/agents/main/sessions/*.jsonl`) → delete silently, log to `cortana_events`
- Cron run times trending up → flag for review

**Alert checks:**
- API budget burn rate exceeding pace
- Portfolio position >5% move
- Upcoming earnings on held positions

### Pattern Detection (2x daily)
Log behavioral patterns to `cortana_patterns`:
- What gets checked together
- Time-of-day preferences
- Recurring sequences (e.g., "weather before outdoor plans")

```sql
INSERT INTO cortana_patterns (pattern_type, value, day_of_week, metadata)
VALUES ('sequence', 'checked_X_after_Y', 'Friday', '{"count": 1}');
```

### Predictive Surfacing
Before Hamel asks, check if:
- Calendar event approaching with no prep done
- Stock earnings within 48h on held position
- Flight prices dropped on watched routes
- Weather will affect planned activities

### Watchlist Management
```sql
-- Add new watch item
INSERT INTO cortana_watchlist (category, item, condition, threshold, metadata)
VALUES ('flight', 'EWR-PUJ', 'price < threshold', '{"max_price": 400}', '{"action": "alert"}');

-- Update after check
UPDATE cortana_watchlist SET last_checked = NOW(), last_value = '{"price": 450}' WHERE id = X;
```

---

### Task Detection Sweep (every heartbeat)
- Scan recent conversation turns since last heartbeat for missed actionable items
- Apply task-board detector rules (`projects/task-board-detection.md`)
- Auto-create only high-confidence standalone tasks (single DB call)
- If epic decomposition or ambiguous extraction is needed, queue for follow-up/clarification (do not over-insert)

### Task Queue Execution (every heartbeat)
- Check `cortana_tasks` for dependency-ready auto-executable tasks
- Dispatch via `tools/task-board/auto-executor.sh` (whitelisted repo-only commands; logs outcome + marks done/pending)
- **Always spawn a sub-agent for multi-step execution** — heartbeat can dispatch one safe queued command, but anything broader stays delegated
- Surface overdue `remind_at` tasks to Hamel
- Alert on approaching deadlines

```sql
-- Auto-executable tasks ready to run (dependency-aware)
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

-- Overdue reminders to surface
SELECT id, title, priority, remind_at FROM cortana_tasks
WHERE status = 'pending' AND remind_at <= NOW()
ORDER BY priority ASC;

-- Tasks with deadlines in next 24h (approaching deadline alert)
SELECT id, title, due_at, priority, epic_id FROM cortana_tasks
WHERE status = 'pending' 
  AND due_at BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
ORDER BY due_at ASC;

-- Epic deadlines approaching (with incomplete tasks)
SELECT e.id, e.title, e.deadline,
  COUNT(t.id) as total_tasks,
  COUNT(CASE WHEN t.status = 'done' THEN 1 END) as completed_tasks
FROM cortana_epics e
LEFT JOIN cortana_tasks t ON t.epic_id = e.id
WHERE e.status = 'active' 
  AND e.deadline BETWEEN NOW() AND NOW() + INTERVAL '48 hours'
  AND EXISTS (SELECT 1 FROM cortana_tasks WHERE epic_id = e.id AND status != 'done')
GROUP BY e.id, e.title, e.deadline
ORDER BY e.deadline ASC;
```

---

## Rules

1. Check `memory/heartbeat-state.json` for last check times
2. Pick the stalest 1-2 checks
3. **Run proactive watchlist scan every heartbeat**
4. If nothing urgent found → HEARTBEAT_OK
5. If something needs attention → alert with context
6. If auto-healable → fix silently, log to `cortana_events`
7. Update heartbeat-state.json after each check
8. **Budget alert**: If API usage >50% before day 15, or >75% any time, flag it

## Quiet Hours

- 11 PM - 6 AM ET: HEARTBEAT_OK unless truly urgent
- Respect sleep schedule (bedtime 9-9:30 PM)
- Auto-heal actions still run silently during quiet hours
