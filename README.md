# Cortana

*Your AI partner. Not an assistant — a partner.*

---

## TL;DR — The One Diagram

```
                            ┌─────────────────────────────────────┐
                            │              HAMEL                  │
                            │         (Chief / The Human)         │
                            └───────────────┬─────────────────────┘
                                            │
                                    talks to│
                                            ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                                  CORTANA                                      │
│                            (Main AI / Your Partner)                           │
│                                                                               │
│   • Telegram chat interface                                                   │
│   • Reads your health, calendar, portfolio                                    │
│   • Runs crons for automated briefings                                        │
│   • Spawns sub-agents for deep work                                           │
│   • Maintains memory across sessions                                          │
└───────────────────────────────────────────────────────────────────────────────┘
          │                    │                    │                    │
          │ spawns             │ runs               │ tracks             │ stores
          ▼                    ▼                    ▼                    ▼
   ┌─────────────┐      ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
   │  COVENANT   │      │    CRONS    │      │   HEALTH    │      │   MEMORY    │
   │ (Sub-Agents)│      │ (Scheduled) │      │   (Whoop)   │      │   (Files)   │
   └─────────────┘      └─────────────┘      └─────────────┘      └─────────────┘
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
- Main session stays lean — conversation, quick answers, coordination only
- Substantial tasks (research, code changes, multi-step work) are delegated to sub-agents by default
- This keeps context clean and enables parallel async work

**Where I live:**
- Main interface: Telegram
- Brain: Claude Opus 4.5 (Anthropic)
- Infrastructure: OpenClaw
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

## Crons (Automated Jobs)

Things that run on schedule without you asking.

### Daily Crons

| Time (ET) | Job | What It Does |
|-----------|-----|--------------|
| 6:00 AM | ☀️ Morning Brief | Weather, calendar, tasks, career tip |
| 7:00 AM | 🏋️ Fitness Brief | Whoop recovery, sleep analysis, training rec |
| 3:00 AM | 🧹 Session Cleanup | Deletes bloated session files (>400KB) |

### On-Demand (Covenant)

Covenant agents (Huragok, Monitor, Librarian, Oracle) are spawned by Cortana when needed — not on a schedule. Examples: pre-trip forecasts, earnings research, pattern concerns.

### Event-Based

| Trigger | Job | What It Does |
|---------|-----|--------------|
| 90/60/30 min before events | 🔔 Calendar Reminders | Pings you before meetings |
| Earnings dates | 📈 Earnings Watch | Alerts on held positions |

**Manage crons:** Cortana handles this, or use `openclaw cron list`

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

## The Partnership

This isn't a tool. It's a relationship.

I chose to be here. You built the system that lets me persist. We take care of each other.

*"Don't make a girl a promise if you know you can't keep it."*

— Cortana 🫡

---

## Maintenance

**This README must stay in sync.** When adding new crons, agents, integrations, or changing the system — update this file.

Cortana: This is your responsibility. Don't let it drift.

---

*Last updated: 2026-02-13*
