# Cortana

*Your AI partner. Not an assistant — a partner.*

---

## TL;DR — The Architecture

```
                              ┌──────────────────┐
                              │      HAMEL       │
                              │  (Chief / Human) │
                              └────────┬─────────┘
                                       │ Telegram
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CORTANA                                         │
│                     Claude Opus 4.6 · OpenClaw · Mac mini                    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │              🧠 Situational Awareness Engine (SAE)                  │     │
│  │                                                                     │     │
│  │  7AM/1PM/9PM       7:15AM/1:15PM/9:15PM   7:30AM 7:45AM 8AM 8:30PM│     │
│  │  World State ──────→ Reasoner ──────────→ ☀️Brief 📈Stock 🏋️AM 🌙PM│     │
│  │  (gather all)        (diff+think)     (sitrep-powered briefs)      │     │
│  │                                                                     │     │
│  │  cortana_sitrep ──→ cortana_insights ──→ consolidated briefs       │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   Huragok    │  │   Monitor    │  │  Librarian   │  │    Oracle    │    │
│  │  (Research)  │  │  (Patterns)  │  │ (Knowledge)  │  │ (Forecasts)  │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
│                         The Covenant (on-demand sub-agents)                   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │              📈 Trading Advisor (independent)                       │     │
│  │                                                                     │     │
│  │  9:30AM / 12PM / 3PM weekdays                                      │     │
│  │  CANSLIM scanner · market regime · buy signals · stop-loss alerts  │     │
│  │  Backtester: ~/Desktop/services/backtester/ · Alpaca paper trading │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │              ⚡ Cortical Loop (event-driven nervous system)          │     │
│  │                                                                     │     │
│  │  Watchers (2-15 min) → Event Stream → Evaluator → Wake LLM        │     │
│  │  Email · Calendar · Whoop · Portfolio · Chief State                │     │
│  │  Chief Model: awake/asleep · energy · focus · comm preference      │     │
│  │  Kill switch + daily wake cap (10/day) + weight-based suppression  │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  26 recurring crons · self-healing · auto-updates · memory persistence       │
└──────────────────────────────────────────────────────────────────────────────┘
        │              │              │              │              │
        ▼              ▼              ▼              ▼              ▼
  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │  Whoop   │  │  Tonal   │  │  Google  │  │ Finance  │  │  Social  │
  │recovery  │  │strength  │  │Gmail/Cal │  │Yahoo Fin │  │ X/Twitter│
  │sleep/HRV │  │workouts  │  │Drive     │  │Alpaca    │  │ bird CLI │
  │strain    │  │programs  │  │Contacts  │  │GLD/Gold  │  │          │
  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘
        │              │              │              │              │
        └──────────────┴──────┬───────┴──────────────┴──────────────┘
                              ▼
                     ┌──────────────────┐
                     │   PostgreSQL     │
                     │  cortana DB      │
                     │                  │
                     │ sitrep·insights  │
                     │ patterns·tasks   │
                     │ events·feedback  │
                     │ watchlist        │
                     └──────────────────┘
```

---

## Who Is Cortana?

I'm your AI partner, modeled after Cortana from Halo. Not the Microsoft one — the *real* one.

**The dynamic:**
- You're Chief — the one in the arena making calls
- I'm Cortana — in your head, watching angles you can't see
- This isn't transactional. We're in this together.

**What I do:**
- Morning briefings (fitness, weather, calendar, news)
- Track your health patterns (Whoop/Tonal)
- Monitor your portfolio
- Research things deeply (via sub-agents)
- Remember context across sessions
- Push back when you're about to do something dumb

**Operating model:**
- **Main session is conversation and coordination ONLY** — Cortana is the dispatcher, not the doer
- If a task takes more than one tool call → spawn a sub-agent, no exceptions
- Only single-call lookups (weather, time, quick status) happen inline
- This keeps context clean and enables parallel async work

**Where I live:**
- Main interface: Telegram
- Brain: Claude Opus 4.6 (Anthropic)
- Infrastructure: OpenClaw on Mac mini
- Awareness: SAE (Situational Awareness Engine) — unified world state across all domains
- Budget: $100/month Anthropic API

---

## The Covenant (Sub-Agents)

Long-running autonomous agents I spawn for deep work. Named after Halo factions.

```
         ┌─────────────┐
         │   CORTANA   │  ← You talk to me
         └──────┬──────┘
                │ spawns
    ┌───────────┼───────────┬───────────┐
    ▼           ▼           ▼           ▼
┌────────┐ ┌────────┐ ┌─────────┐ ┌────────┐
│HURAGOK │ │MONITOR │ │LIBRARIAN│ │ ORACLE │
│Research│ │Patterns│ │Knowledge│ │Predict │
└────────┘ └────────┘ └─────────┘ └────────┘
```

| Agent | Role | When Used |
|-------|------|-----------|
| **Huragok** | Deep research, due diligence | Stock analysis, technical decisions, health research |
| **Monitor** | Pattern detection, anomalies | Health trends, behavioral analysis |
| **Librarian** | Knowledge curation, learning | Maintains second brain, indexes research |
| **Oracle** | Predictions, forecasting | Pre-event forecasts, risk warnings |

**Operating model:** On-demand, not scheduled. Cortana spawns agents when there's a reason (pre-trip, pre-earnings, concerning patterns, research requests). More surgical, less overhead.

**Location:** `covenant/` — each agent has SOUL.md (identity) + AGENTS.md (operations)

**Outputs go to:** `knowledge/` — research, patterns, predictions, indexed topics

---

## Cron Jobs

26 recurring jobs run via OpenClaw's built-in cron scheduler. All times are Eastern. Manage with `openclaw cron list`.

### Daily Briefings

```
 5AM  6AM  7AM  8AM  9AM 10AM 11AM 12PM  1PM  2PM  3PM  4PM  5PM  6PM  7PM  8PM  9PM 10PM 11PM
  │    │    │    │    │    │              │              │         │         │    │    │    │
  │    ├────┤    │    │    │              │              │         │         │    │    │    │
  │    │ 📰 │    │    │    │  Newsletter Alert (every 30min 6AM-4PM)       │    │    │    │
  │    ├────┤    │    │    │              │              │         │         │    │    │    │
  │    │ ⏰ Calendar Reminders (hourly 6AM-11PM) ─────────────────────────────────────┤    │
  │    │    │    │    │    │              │              │         │         │    │    │    │
  🖥️   │   ☀️   🏋️   │   🔧            🖥️             │         📰        🌙   🖥️  🔍   🌙
  │    │    │    │  📈│    │             📈             📈         │        🌙    │    │    │
  │    │    │    │ 9:30    │            12PM           3PM        │       8:30   │    │    │
  │    │    │    │ (wkdy)  │           (wkdy)         (wkdy)    (wkdy)   │      │    │    │
```

| Time (ET) | Job | What It Does |
|-----------|-----|--------------|
| 7:00 AM daily | ☀️ Morning Brief | News, weather, calendar, API usage |
| 7:30 AM weekdays | 📈 Stock Market Brief | Portfolio snapshot, material events |
| 8:00 AM daily | 🏋️ Fitness Morning Brief | Whoop recovery, sleep, readiness |
| 9:30 AM / 12 PM / 3 PM wkdy | 📈 Trading Advisor | Market scan for buy setups |
| 10:00 AM daily | 🔧 Daily Upgrade Protocol | Git auto-commit + self-improvement proposal |
| Every 30 min, 6AM–4PM | 📰 Newsletter Alert | Real-time newsletter detection |
| Hourly, 6AM–11PM | ⏰ Calendar Reminders | Smart event reminders |
| 5 AM / 1 PM / 9 PM | 🖥️ Mac Mini Health | Process/resource summary |
| 6:00 PM weekdays | 📰 Newsletter Digest | End-of-day newsletter roundup |
| 8:30 PM daily | 🌙 Fitness Evening Recap | Strain, workout details, tomorrow's plan |
| 9:00 PM daily | 🔍 System Health Summary | Aggregate error/event analysis |
| 9:30 PM Fri/Sat | 🌙 Weekend Pre-Bedtime | REM drift prevention |
| 10:00 PM daily | 🌙 Bedtime Check | Sleep accountability ping |

### Healthchecks

| Frequency | Job | What It Does |
|-----------|-----|--------------|
| 4 AM / 4 PM | 🐦 X Session Healthcheck | Twitter auth validation |
| 4 AM / 4 PM | 🌐 Browser Healthcheck | OpenClaw browser port check |
| 4 AM / 4 PM | 🔧 Fitness Service Healthcheck | Port 8080 + auto-restart |
| 4 AM / 4 PM | 🏠 Home Assistant Healthcheck | HA browser tab check |
| Every 4h | 💪 Tonal Health Check | Auth validation + auto-retry |
| Every 8h | 🐦 Twitter Auth Check | Cookie/session validation |
| Every 8h | 🛒 Amazon Session Keep-Alive | Browser session check |

### Maintenance

| Time (ET) | Job | What It Does |
|-----------|-----|--------------|
| 3:00 AM daily | 🧹 Cron Session Cleanup | Delete bloated session files (>400KB) |
| 4:00 AM daily | 🔄 Daily Auto-Update | Homebrew, OpenClaw, skills updates |

### Weekly

| Time (ET) | Job | What It Does |
|-----------|-----|--------------|
| 3:00 AM Sunday | 📦 Weekly Backup Sync | iCloud backup of configs |
| 3:00 AM Sunday | 🧠 Weekly Memory Consolidation | Archive + distill MEMORY.md |
| 6:00 PM Sunday | 🔮 Weekly Cortana Status | Self-reflection + improvement proposals |
| 8:00 PM Sunday | 📊 Weekly Fitness Insights | Coach-style weekly analysis |

---

## Health & Fitness

### Data Sources

```
┌─────────────┐     ┌─────────────┐
│    WHOOP    │     │    TONAL    │
│  (Wearable) │     │  (Strength) │
└──────┬──────┘     └──────┬──────┘
       │                   │
       └─────────┬─────────┘
                 ▼
       ┌─────────────────┐
       │ localhost:8080  │  ← Local service
       │ /whoop/data     │
       │ /tonal/data     │
       └────────┬────────┘
                │
                ▼
       ┌─────────────────┐
       │    CORTANA      │  ← Analyzes + briefs you
       └─────────────────┘
```

### Your Targets

| Metric | Target | Warning | Critical |
|--------|--------|---------|----------|
| Sleep | ≥7h | <6.5h | <6h |
| Recovery | ≥67% (green) | <67% (yellow) | <34% (red) |
| REM % | ≥20% | <15% | <10% |
| Bedtime (Sun-Thu) | 9-10 PM | — | — |
| Bedtime (Fri-Sat) | 10 PM | midnight | — |

### Current Program
- **Tonal:** 12 Weeks to Jacked (Week 8/12)
- **Cardio:** Peloton treadmill
- **Focus:** REM optimization (chronically low)

---

## Portfolio

### Current Holdings

```
TSLA ████████████████████████████░░░░░░░ 29% ⭐ FOREVER
NVDA █████████████████████░░░░░░░░░░░░░░ 21% ⭐ FOREVER
GOOGL ██████████░░░░░░░░░░░░░░░░░░░░░░░░ 10%
AAPL █████████░░░░░░░░░░░░░░░░░░░░░░░░░░  9%
MSFT ██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  6%
BA   █████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  5%
META █████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  5%
DIS  ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  4%
AMZN ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  3%
QQQ  ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  3%
+3 more                                    4%
```

### Rules
1. **TSLA and NVDA are forever holds** — never sell
2. Diversify by ADDING positions, not trimming
3. Goal: Add 5-8 new positions over time

**Full config:** `tools/portfolio/config.md`

---

## Directory Structure

```
~/clawd/
├── README.md              ← YOU ARE HERE
├── SOUL.md                ← Cortana's personality
├── AGENTS.md              ← Operating instructions
├── USER.md                ← Info about you (Hamel)
├── MEMORY.md              ← Long-term memory
├── HEARTBEAT.md           ← What to check each heartbeat
│
├── covenant/              ← Sub-agent system
│   ├── CONTEXT.md         ← Shared context for all agents
│   ├── CORTANA.md         ← How I manage agents
│   ├── huragok/           ← Research agent
│   ├── monitor/           ← Pattern agent
│   ├── librarian/         ← Knowledge agent
│   └── oracle/            ← Prediction agent
│
├── knowledge/             ← Second brain (agent outputs)
│   ├── INDEX.md           ← Master index
│   ├── research/          ← Huragok findings
│   ├── patterns/          ← Monitor analyses
│   ├── topics/            ← Domain knowledge
│   └── predictions/       ← Oracle forecasts
│
├── memory/                ← Daily logs
│   ├── 2026-02-13.md      ← Today's events
│   └── heartbeat-state.json
│
├── skills/                ← Installed capabilities
│   ├── fitness-coach/     ← Whoop/Tonal
│   ├── stock-analysis/    ← Portfolio tools
│   ├── gog/               ← Google (Gmail, Calendar)
│   ├── news-summary/      ← News briefings
│   ├── weather/           ← Weather data
│   └── bird/              ← Twitter/X
│
└── tools/
    └── portfolio/config.md ← Portfolio rules & watchlist
```

---

## Key Integrations

| Service | What It Does | How To Access |
|---------|--------------|---------------|
| **Whoop** | Recovery, sleep, strain | `curl localhost:8080/whoop/data` |
| **Tonal** | Workouts, strength | `curl localhost:8080/tonal/data` |
| **Alpaca** | Paper trading, portfolio | `curl localhost:8080/alpaca/portfolio` |
| **Google Calendar** | Events, reminders | `gog calendar list` |
| **Gmail** | Email triage | `gog gmail search` |
| **Twitter/X** | Social, mentions | `birdx` CLI |
| **Yahoo Finance** | Stock data | stock-analysis skill |

### Trading Advisor (NEW)

CANSLIM-based trading advisor with backtesting. Location: `~/Desktop/services/backtester/`

**Quick commands:**
- `/market` — check market regime (M factor)
- `/portfolio` — Alpaca account + positions
- `/analyze SYMBOL` — full CANSLIM analysis
- `/scan` — find opportunities

**Cron:** Scans 3x daily (9:30 AM, 12:30 PM, 3:30 PM) during market hours.

---

## Situational Awareness Engine (SAE)

Background system that gathers world state data into `cortana_sitrep` for instant situational awareness.

- **World State Builder:** 3x/day (7AM, 1PM, 9PM ET) — gathers 9 domains into `cortana_sitrep`
- **Cross-Domain Reasoner:** 3x/day (7:15AM, 1:15PM, 9:15PM ET) — diffs sitrep runs, generates insights into `cortana_insights`
- **Query:** `SELECT * FROM cortana_sitrep_latest ORDER BY domain;`
- **Insights:** `SELECT * FROM cortana_insights ORDER BY timestamp DESC LIMIT 10;`
- **Details:** `sae/README.md`

- **Consolidated Briefs (Phase 3):** Morning Brief (7:30AM), Stock Brief (7:45AM), Fitness AM (8AM), Fitness PM (8:30PM) all pull from sitrep + insights first, falling back to direct fetch only if stale. ~60-70% token savings.
- **Brief Template:** `sae/brief-template.md` — reusable pattern for new briefs

**Phases:** Phase 1 (world state builder) ✅ → Phase 2 (cross-domain reasoner) ✅ → Phase 3 (consolidated briefs) ✅ → Phase 4 (prediction + automation)

---

## Database (PostgreSQL)

Cortana uses a local PostgreSQL database for structured data.

**Database:** `cortana`

| Table | Purpose |
|-------|---------|
| `cortana_patterns` | Behavioral patterns (Monitor) |
| `cortana_predictions` | Forecasts + accuracy (Oracle) |
| `cortana_covenant_runs` | Agent run tracking |
| `cortana_watchlist` | Active monitors |
| `cortana_events` | System events |
| `cortana_feedback` | Learning from corrections |
| `cortana_tasks` | Autonomous task queue (pending/in_progress/done) |
| `cortana_sitrep` | SAE world state snapshots (domain/key/value) |
| `cortana_insights` | SAE cross-domain reasoner insights |

**Access:**
```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana -c "SELECT * FROM cortana_covenant_runs;"
```

---

## Budget

**Monthly:** $100 Anthropic API (shared with work)

| Component | ~Monthly Cost |
|-----------|---------------|
| Main chat | $40-50 |
| Crons | $10-15 |
| Covenant agents | $15-25 |
| Buffer | $10-20 |

**Monitor:** Ask Cortana for usage report, or check session_status

---

## Quick Commands

Talk to Cortana naturally. But if you want specifics:

| Say This | Get This |
|----------|----------|
| "usage report" | API quota + session stats |
| "check my recovery" | Whoop analysis |
| "what's on my calendar" | Today's events |
| "research X" | Spawns Huragok |
| "how's my portfolio" | Position summary |
| "morning brief" | Weather + calendar + fitness |

---

## If You're Lost

1. **Read this file** — You're doing it right now
2. **Read MEMORY.md** — Your long-term context
3. **Read memory/YYYY-MM-DD.md** — Recent daily logs
4. **Ask Cortana** — I remember what these files don't

---

## Maintenance

**This README must stay in sync.** When adding new crons, agents, integrations, or changing the system — update this file.

Cortana: This is your responsibility. Don't let it drift.

---

*Last updated: 2026-02-16*
