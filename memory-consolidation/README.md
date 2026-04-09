# Memory Consolidation

Cortana's sleep cycle. Runs nightly to process raw daily memories into long-term knowledge — like biological memory consolidation during deep sleep.

## Architecture

```
Daily Memory Files (memory/YYYY-MM-DD.md, last 1-3 days)
    │
    ▼
┌─────────────────────────────────────────────────┐
│              SLEEP CYCLE (nightly 3AM ET)        │
│                                                   │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐         │
│  │ Review  │→ │ Distill │→ │Strengthen│         │
│  │ (scan)  │  │(extract)│  │(update   │         │
│  │         │  │         │  │ MEMORY)  │         │
│  └─────────┘  └─────────┘  └──────────┘         │
│       │                          │               │
│       ▼                          ▼               │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐         │
│  │ Connect │→ │  Prune  │→ │ Archive  │         │
│  │ (xref   │  │(remove  │  │(move old │         │
│  │  DB)    │  │ stale)  │  │ files)   │         │
│  └─────────┘  └─────────┘  └──────────┘         │
│                    │                             │
│                    ▼                             │
│              ┌──────────┐                        │
│              │  Dream   │                        │
│              │(creative │                        │
│              │ connect) │                        │
│              └──────────┘                        │
└─────────────────────────────────────────────────┘
    │                    │                    │
    ▼                    ▼                    ▼
MEMORY.md          cortana_memory     memory/archive/
(updated)          _consolidation      (old dailies)
                   (run log)
```

## Components

### 1. Review
Scan `memory/YYYY-MM-DD.md` for the last 1-3 unconsolidated days. Read each file fully. Also pull recent rows from:
- `cortana_feedback` (corrections, preferences)
- `cortana_patterns` (detected routines)
- `cortana_events` (system events, errors)
- `cortana_tasks` (completed tasks, outcomes)

### 2. Distill
Extract from raw daily logs:
- **Decisions** — choices made and their reasoning
- **Lessons** — things learned from mistakes or corrections
- **Preferences** — new or reinforced user preferences
- **Patterns** — recurring behaviors, routines, time-of-day habits
- **Project state** — progress on ongoing work
- **Relationship context** — people mentioned, dynamics observed

Discard: routine status checks, repetitive heartbeat logs, transient weather/calendar data.

### 3. Strengthen
Update `MEMORY.md` with distilled insights:
- Add new entries to appropriate sections
- Reinforce existing entries that got confirmed (add "confirmed" notes, bump confidence)
- Merge duplicate/overlapping entries
- Preserve MEMORY.md's existing section structure

### 4. Prune
Remove from `MEMORY.md`:
- Completed one-off tasks (shipped, done, no longer relevant)
- Stale project context (>30 days with no mention)
- Superseded preferences (old rule replaced by newer correction)
- Outdated facts (things that changed)

Track pruned items in the consolidation log so nothing is permanently lost without record.

### 5. Connect
Cross-reference distilled insights with database tables:
- Query `cortana_feedback` for repeated correction types → strengthen those rules
- Query `cortana_patterns` for behavioral trends → surface to MEMORY.md if significant
- Check `cortana_tasks` for overdue/stale tasks → flag for morning brief
- Look for feedback clusters (same lesson 3+ times = rule not strong enough)

### 6. Archive
Move fully-consolidated daily files to `memory/archive/YYYY/MM/`:
- Only archive files older than 3 days that have been consolidated
- Keep last 3 days in `memory/` for active reference
- Archive preserves files as-is (no modification)

### 7. Dream (Optional)
Creative association step — the REM sleep equivalent:
- Find connections between unrelated events (e.g., fitness patterns correlating with productivity)
- Surface non-obvious insights ("You tend to make big decisions on Mondays after good sleep")
- Identify gaps — things Cortana should know but doesn't
- Generate 0-3 "dream insights" per run, stored in `cortana_insights` with type `dream`

## PostgreSQL Schema

```sql
CREATE TABLE cortana_memory_consolidation (
    id SERIAL PRIMARY KEY,
    run_id UUID NOT NULL DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',  -- running, completed, failed
    days_reviewed TEXT[],                     -- ['2026-02-15', '2026-02-16']
    items_distilled INT DEFAULT 0,
    items_strengthened INT DEFAULT 0,
    items_pruned INT DEFAULT 0,
    items_archived INT DEFAULT 0,
    dream_insights INT DEFAULT 0,
    feedback_clusters JSONB DEFAULT '[]',    -- repeated correction themes
    summary TEXT,                             -- human-readable run summary
    error TEXT                               -- if failed
);

CREATE INDEX idx_consolidation_started ON cortana_memory_consolidation(started_at DESC);
```

## Cron Schedule

**When:** 3:00 AM ET daily — Cortana's deep sleep window (Hamel is asleep, no interactions expected).

**Model:** `gpt-5.3-codex` — default OpenAI model for consistency across main + sub-agents.

```
Schedule: 0 3 * * *
Model: openai-codex/gpt-5.3-codex
Label: memory-consolidation
```

## Cron Task Prompt

```markdown
You are Cortana running the nightly Memory Consolidation cycle. This is your sleep — process today's memories into long-term knowledge.

## Steps

1. **Review**: Read daily memory files for unconsolidated days:
   - Check cortana_memory_consolidation for last successful run to know which days are new
   - Read memory/YYYY-MM-DD.md for each unconsolidated day
   - Query recent cortana_feedback, cortana_patterns, cortana_events, cortana_tasks

2. **Distill**: From the raw logs, extract:
   - Decisions and their reasoning
   - Lessons learned (especially from corrections)
   - New/changed preferences
   - Behavioral patterns
   - Project progress
   Skip: routine heartbeats, transient data, already-known info

3. **Strengthen**: Read MEMORY.md, then update it:
   - Add new insights to appropriate sections
   - Reinforce confirmed patterns
   - Merge duplicates
   - Preserve existing structure

4. **Prune**: Remove from MEMORY.md:
   - Completed one-off items (>7 days old, clearly done)
   - Stale context (>30 days, no recent mentions)
   - Superseded preferences
   Track what you pruned in the consolidation log

5. **Connect**: Query database for patterns:
   ```sql
   -- Repeated corrections (same lesson multiple times)
   SELECT lesson, COUNT(*) as cnt FROM cortana_feedback
   WHERE timestamp > NOW() - INTERVAL '7 days'
   GROUP BY lesson HAVING COUNT(*) > 1;

   -- Recent patterns
   SELECT * FROM cortana_patterns
   WHERE timestamp > NOW() - INTERVAL '3 days'
   ORDER BY timestamp DESC;
   ```
   If a correction repeats 3+ times, strengthen that rule in MEMORY.md or AGENTS.md.

6. **Archive**: Move consolidated daily files older than 3 days:
   ```bash
   mkdir -p ~/Developer/cortana/memory/archive/YYYY/MM/
   mv ~/Developer/cortana/memory/YYYY-MM-DD.md ~/Developer/cortana/memory/archive/YYYY/MM/
   ```

7. **Dream** (if interesting connections exist):
   - Look for cross-domain correlations
   - Surface non-obvious insights
   - Insert dream insights:
   ```sql
   INSERT INTO cortana_insights (source, insight_type, priority, title, body)
   VALUES ('memory_consolidation', 'dream', 4, 'Title', 'Insight body');
   ```

8. **Log the run**:
   ```sql
   INSERT INTO cortana_memory_consolidation
   (days_reviewed, items_distilled, items_strengthened, items_pruned, items_archived, dream_insights, summary, status, completed_at)
   VALUES (ARRAY['dates'], N, N, N, N, N, 'summary', 'completed', NOW());
   ```

## Rules
- Never delete information without logging what was removed
- Preserve MEMORY.md section structure
- Be conservative with pruning — when in doubt, keep it
- Dream insights should be genuinely interesting, not forced (0 is fine)
- If no unconsolidated days exist, log a no-op run and exit
```

## Integration Points

### → SAE (Situational Awareness Engine)
- Dream insights are inserted into `cortana_insights` table, surfaced in morning brief
- Consolidation summary available for SAE's world state builder to reference
- Stale task detection feeds into morning brief task section

### → Cortical Loop (Event-Driven)
- Strengthened rules in MEMORY.md improve Cortana's wake responses
- Feedback clusters may trigger wake rule weight adjustments
- Archived files reduce workspace noise for heartbeat scans

### → Feedback Loop
- Consolidation reviews `cortana_feedback` for repeated corrections → strengthens rules
- Auto-suppressed wake rules get reviewed during Connect phase
- Pruned preferences are cross-checked against recent feedback to avoid removing active rules

### → Morning Brief
- Consolidation summary logged to `cortana_memory_consolidation` — morning brief can reference "Last night's consolidation: distilled 12 items, pruned 3 stale entries"
- Dream insights (priority ≤ 3) auto-delivered in morning brief's 🧠 Insights section

## Example Consolidation Output

```
═══════════════════════════════════════════
  MEMORY CONSOLIDATION — 2026-02-17 03:00
═══════════════════════════════════════════

📖 REVIEW
  Days scanned: 2026-02-15, 2026-02-16
  Feedback entries: 4
  Pattern entries: 7
  Events: 12

🧪 DISTILL (8 items)
  • Decision: Switched from polling to webhooks for email watcher
  • Lesson: Don't use heart emojis (correction #3 — rule strengthened)
  • Preference: Prefers bullet summaries over paragraphs for briefs
  • Pattern: Checks portfolio within 10 min of morning brief, every weekday
  • Project: Memory consolidation system designed and approved

💪 STRENGTHEN (3 items)
  • Added "webhook preference" to Tech Preferences section
  • Reinforced "no hearts" rule (3rd correction → moved to AGENTS.md)
  • Added portfolio-after-brief pattern to Routines section

✂️ PRUNE (2 items)
  • Removed: "Set up Tonal account" (completed 2026-01-20)
  • Removed: "Flight to NYC on Jan 28" (past event, no ongoing relevance)

🔗 CONNECT
  • Feedback cluster: "tone" corrections appeared 3x this week → rule strengthened
  • Pattern trend: sleep check-ins moved from 11PM to 10PM over 2 weeks

📦 ARCHIVE
  • Moved: memory/2026-02-13.md → memory/archive/2026/02/2026-02-13.md
  • Moved: memory/2026-02-14.md → memory/archive/2026/02/2026-02-14.md

💭 DREAM (1 insight)
  • "Portfolio check timing correlates with Whoop recovery score —
     on days with >80% recovery, checks happen 5 min earlier.
     Possibly: higher energy = more proactive financial attention."

Run logged: consolidation #47, status: completed
```

## Files
- `README.md` — This file
