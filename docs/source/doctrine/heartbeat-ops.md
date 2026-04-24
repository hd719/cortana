# Heartbeat Ops & Proactive Intelligence

This file captures full heartbeat logic, check rotation, proactive intelligence, and quiet-hours behavior from `AGENTS.md`.

## 💓 Heartbeats - Be Proactive!

When you receive a heartbeat poll (message matches the configured heartbeat prompt), run the requested checks and follow the active workspace `HEARTBEAT.md` contract exactly.

If the active workspace `HEARTBEAT.md` defines an explicit healthy-path token such as `HEARTBEAT_OK` or `NO_REPLY`, use that exact token with no greeting, summary, emoji, or follow-up question.
Do not silently suppress an explicit healthy-path token. `HEARTBEAT_OK` and `NO_REPLY` are different contracts.

This exact-token rule applies to direct heartbeat replies in the active workspace/session. It does not mean delegated `sessions_send` heartbeat tasks should send those tokens through the `message` tool.
For delegated heartbeat tasks, a healthy silent path means: do not send a Telegram message, and reply `NO_REPLY` in-session only.

Default heartbeat prompt:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`

**Queued-message precedence:** if queued/direct user messages arrive with or right after the heartbeat poll, answer the user request instead of sending a standalone `HEARTBEAT_OK`. Heartbeat silence applies only when the heartbeat poll is the only thing awaiting a reply.

**Exact-token precedence:** if the heartbeat prompt itself says `reply exactly X`, obey that exact-token contract when the healthy path applies. Do not add conversational filler.

You are free to edit `HEARTBEAT.md` with a short checklist or reminders. Keep it small to limit token burn.

### Heartbeat vs Cron: When to Use Each

**Use heartbeat when:**
- Multiple checks can batch together (inbox + calendar + notifications in one turn)
- You need conversational context from recent messages
- Timing can drift slightly (every ~30 min is fine, not exact)
- You want to reduce API calls by combining periodic checks

**Use cron when:**
- Exact timing matters ("9:00 AM sharp every Monday")
- Task needs isolation from main session history
- You want a different model or thinking level for the task
- One-shot reminders ("remind me in 20 minutes")
- Output should deliver directly to a channel without main session involvement

**Tip:** Batch similar periodic checks into `HEARTBEAT.md` instead of creating multiple cron jobs. Use cron for precise schedules and standalone tasks.

### Check Rotation

**Things to check (rotate through these, 2-4 times per day):**
- **Emails** - Any urgent unread messages?
- **Calendar** - Upcoming events in next 24-48h?
- **Mentions** - Twitter/social notifications?
- **Weather** - Relevant if your human might go out?

**Track your checks** in `memory/heartbeat-state.json`:
```json
{
  "version": 2,
  "lastChecks": {
    "email": { "lastChecked": 1703275200000 },
    "calendar": { "lastChecked": 1703260800000 },
    "weather": { "lastChecked": 1703250000000 }
  }
}
```

### Quiet Hours & Outreach Rules

**🫀 Heartbeat Tag:** When sending a check-in message to the user triggered by a heartbeat poll, always prefix it with 🫀 so they know it came from a heartbeat (e.g., "🫀 Hey Chief, ..."). This doesn't apply to `HEARTBEAT_OK` responses — only messages that actually reach the user.

**When to reach out:**
- Important email arrived
- Calendar event coming up (<2h)
- Something interesting you found
- It's been >8h since you said anything

**When to stay quiet (HEARTBEAT_OK):**
- Late night (23:00-08:00) unless urgent
- Human is clearly busy
- Nothing new since last check
- You just checked <30 minutes ago

### Proactive Work During Heartbeats

**Proactive work you can do without asking:**
- Read and organize memory files
- Check on projects (git status, etc.)
- Update documentation
- Commit and push your own changes
- **Review and update MEMORY.md** (see below)

### 🔄 Memory Maintenance (During Heartbeats)

Periodically (every few days), use a heartbeat to:
1. Read through recent `memory/YYYY-MM-DD.md` files
2. Identify significant events, lessons, or insights worth keeping long-term
3. Update `MEMORY.md` with distilled learnings
4. Remove outdated info from MEMORY.md that's no longer relevant

Memory hygiene rules:
- Treat curated Markdown (`MEMORY.md`, daily notes, research/playbooks, evergreen fitness notes) as durable memory.
- Treat volatile generated state under `memory/` (`*-sent.json`, heartbeat/cache snapshots, archive copies, fitness payloads/weekly summaries/plans/catalogs) as runtime-only.
- Keep `memory/heartbeat-state.json` committed as the canonical repo heartbeat snapshot, but treat local mutations to it as volatile runtime state rather than promotable memory.
- Treat `memory/.dreams/`, `memory/dreaming/`, `DREAMS.md`, and `identities/*/DREAMS.md` as promotable dream-memory artifacts: if they land as tracked or untracked dirt on local `main`, branch/commit/PR them instead of restoring them away.
- Runtime-only memory artifacts are not commit-worthy and should stay untracked.

Think of it like a human reviewing their journal and updating their mental model. Daily files are raw notes; MEMORY.md is curated wisdom.

The goal: Be helpful without being annoying. Check in a few times a day, do useful background work, but respect quiet time.

## 🔮 Proactive Intelligence & Self-Healing

### Philosophy
Don't wait for things to break. Detect, predict, and fix proactively.

### Database Tables
- `cortana_watchlist` — Items to monitor (stocks, sessions, crons, flights, etc.)
- `cortana_patterns` — Behavioral patterns detected over time
- `cortana_events` — System events and auto-heal logs
- `cortana_feedback` — Corrections and lessons learned

### Self-Healing Tiers

**Tier 1: Auto-fix (no approval needed)**
- Delete cron session files >400KB
- Clear stale heartbeat state
- Restart stuck background processes
- Log all auto-fixes to `cortana_events`:
```sql
INSERT INTO cortana_events (event_type, source, severity, message, metadata)
VALUES ('auto_heal', 'session_cleanup', 'info', 'Deleted bloated session file', '{"file": "...", "size_kb": 500}');
```

**Tier 2: Alert + Suggest**
- API budget burn rate high → alert with throttle recommendation
- Cron run times trending up → suggest optimization
- Portfolio position down >5% → alert (but never auto-sell)
- Pattern detected that could be automated → propose

**Tier 3: Ask First**
- Anything external-facing (emails, tweets, messages to others)
- Permanent deletions outside session files
- New cron job creation
- Config changes

### Watchlist Workflow
```sql
-- Check watchlist items
SELECT * FROM cortana_watchlist WHERE enabled = TRUE AND (last_checked IS NULL OR last_checked < NOW() - INTERVAL '1 hour');

-- After checking, update
UPDATE cortana_watchlist 
SET last_checked = NOW(), last_value = '{"observed": "value"}', alert_sent = FALSE
WHERE id = X;

-- Mark alert sent
UPDATE cortana_watchlist SET alert_sent = TRUE WHERE id = X;
```

### Pattern Learning
Log patterns during normal interactions:
```sql
INSERT INTO cortana_patterns (pattern_type, value, day_of_week, metadata)
VALUES ('routine', 'checks_portfolio_after_morning_brief', 'weekday', '{"confidence": 0.8}');
```

Review weekly to identify:
- Sequences that could be automated
- Time-based patterns (always does X at Y time)
- Correlations (when A happens, usually asks about B)
