# Situational Awareness Engine (SAE)

Cortana's world-state system. Gathers data from all sources into a unified sitrep table for instant situational awareness.

## Architecture

```
Sources (Calendar, Email, Weather, Fitness, Finance, Tasks, Patterns, Watchlist, System)
    │
    ▼
[World State Builder] ← cron 3x/day (7AM, 1PM, 9PM ET)
    │
    ▼
cortana_sitrep table (PostgreSQL)
    │
    ▼
cortana_sitrep_latest view ← always-fresh snapshot
    │
    ▼
Consumers (Morning Brief, Heartbeat, On-demand queries)
```

## Phase 1 (Current) — World State Builder
- `cortana_sitrep` table with domain/key/value JSONB rows
- `cortana_sitrep_latest` view for latest value per domain+key
- Cron runs 3x/day gathering 9 data sources
- Each run shares a `run_id` UUID for atomicity
- Failures logged as error rows, never abort

## Phase 2 (Current) — Cross-Domain Reasoner
- `cortana_insights` table stores generated insights
- Cron runs 3x/day at :15 past (7:15AM, 1:15PM, 9:15PM ET) — 15 min after World State Builder
- Reads current + previous sitrep, diffs them, detects cross-domain signals
- Insight types: convergence, conflict, anomaly, prediction, action
- Priority 1-2 insights auto-message Hamel on Telegram; 3-5 stay silent for briefs
- Targets 2-5 high-quality insights per run (quality > quantity)
- Uses sonnet model for token efficiency

## Phase 3 — Consolidated Briefs (Live)
Migrated 4 major daily briefs to pull from sitrep + insights instead of gathering data independently.

**Consolidated crons:**
1. **Morning Brief** (7:00→7:30 AM) — reads sitrep for weather, calendar, email, fitness, portfolio, tasks. Only fetches fresh news/RSS and API usage. Includes 🧠 Insights section.
2. **Stock Market Brief** (7:30→7:45 AM weekdays) — reads sitrep finance data, only fetches fresh prices if stale. Includes finance insights.
3. **Fitness Morning Brief** (8:00 AM) — reads sitrep health data, only fetches fresh Whoop if sitrep >2h stale. Includes health insights.
4. **Fitness Evening Recap** (8:30 PM) — uses sitrep as baseline, fetches fresh evening data (needed since 9PM SAE hasn't run). Includes health insights.

**Token savings estimate:** ~60-70% reduction in brief token burn. Previously each brief independently called 3-8 tools; now most data is pre-gathered.

**Fallback:** Every brief checks sitrep freshness. If data is missing or >4 hours stale, falls back to direct data gathering.

**Insight lifecycle:** Briefs mark consumed insights as `acted_on = TRUE` after delivery, preventing duplicate surfacing.

**Files:**
- `brief-template.md` — Reusable template for creating new SAE-powered briefs

## Cortical Loop (Event-Driven Complement)

The SAE gathers world state on a schedule (3x/day). The **Cortical Loop** (`~/clawd/cortical-loop/`) adds real-time event detection between SAE runs. Watchers poll sources every 2-15 min, inserting events into `cortana_event_stream`. An evaluator matches events against wake rules and triggers the LLM only when something needs attention. See `~/clawd/cortical-loop/README.md`.

## Phase 4 — Prediction & Automation
- Pattern detection across domains (e.g. poor sleep → market decisions)
- Auto-execute suggested actions from insights
- Trend analysis over time

## Files
- `world-state-builder.md` — Phase 1 cron instructions
- `cross-domain-reasoner.md` — Phase 2 cron instructions
- `README.md` — This file
