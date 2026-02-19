# HEARTBEAT.md

Rotating checks for heartbeat polls. Pick 1-2 per heartbeat based on staleness.
Track last check times in `memory/heartbeat-state.json`.

## Check Rotation

### Email Triage (2-3x daily)
- Check for urgent unread emails via gog
- Flag anything needing immediate attention
- Skip if checked within last 4 hours

### Calendar Lookahead (2x daily)
- Events in next 24-48 hours
- Conflicts or prep needed?
- Skip if checked within last 6 hours

### Portfolio Alerts (1-2x daily, market hours only)
- Big movers in watchlist (>3% change)
- Earnings surprises
- Skip weekends and after-hours

### Fitness Check-in (1x daily, morning)
- Whoop recovery score
- Workout scheduled?
- Skip if already briefed today

### Weather (1x daily, morning)
- Warren NJ forecast
- Anything notable (rain, extreme temps)?

### API Budget Check (weekly, or if usage seems high)
- Run: `node /Users/hd/clawd/skills/telegram-usage/handler.js`
- Check percentage of $100 monthly budget used
- If >50% before mid-month → alert
- If >75% any time → alert with recommendation to throttle

### Tech News — Critical Tools (2x daily, afternoon + evening)
- Quick search for breaking news on: OpenClaw, Anthropic, OpenAI, tools we rely on
- Sources: TechCrunch, Hacker News front page, web search
- Alert immediately if: acquisitions, shutdowns, major security issues, breaking changes
- Morning brief catches AM news; this catches PM breaking news
- Skip if checked within last 4 hours

---

## 🔮 Proactive Intelligence

### System Health (every heartbeat)
Query watchlist and auto-heal or alert:
```sql
SELECT * FROM cortana_watchlist WHERE enabled = TRUE;
```

**Auto-heal checks:**
- Session files >400KB → delete silently, log to `cortana_events`
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

### Task Queue Execution (every heartbeat)
- Check `cortana_tasks` for dependency-ready auto-executable tasks
- **Always spawn a sub-agent for task execution** — heartbeats are for checking and dispatching, not doing multi-step work inline
- Surface overdue `remind_at` tasks to Hamel
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
