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
│              gpt-5.3-codex (OpenAI) · OpenClaw · Mac mini                │
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
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │              ⚡ Cortical Loop (event-driven nervous system)          │     │
│  │                                                                     │     │
│  │  Watchers (2-15 min) → Event Stream → Evaluator → Wake LLM        │     │
│  │  Email · Calendar · Whoop · Portfolio · Chief State                │     │
│  │  Chief Model: awake/asleep · energy · focus · comm preference      │     │
│  │  Kill switch + daily wake cap (10/day) + weight-based suppression  │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │              🔄 Feedback Loop (learning system)                     │     │
│  │                                                                     │     │
│  │  👍👎❤️🔥😒 reactions ─┐                                            │     │
│  │  Response latency ────┼→ feedback_signals → evaluator → weights    │     │
│  │  "Don't do X" ────────┘                        │                   │     │
│  │                                                 ▼                  │     │
│  │  +0.05 reinforce · -0.15 learn · 3 negatives = auto-suppress      │     │
│  │  Daily learning loop → corrections written to AGENTS.md/MEMORY.md │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │              🌙 Memory Consolidation (sleep cycle)                  │     │
│  │                                                                     │     │
│  │  3 AM daily ─→ Review daily files ─→ Distill insights              │     │
│  │       │            │                      │                        │     │
│  │       ▼            ▼                      ▼                        │     │
│  │  Strengthen MEMORY.md · Prune stale · Archive old dailies          │     │
│  │  Connect (xref DB for patterns) · Dream (creative associations)   │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │              🫀 Proprioception (self-awareness & auto-throttle)     │     │
│  │                                                                     │     │
│  │  Every 15 min: Cron health + Tool health probes ($0 shell)         │     │
│  │  Every 30 min: Budget tracker + Self-model writer ($0 shell)       │     │
│  │  Daily 2:30 AM: Efficiency analyzer (cost-per-cron, engagement)    │     │
│  │                                                                     │     │
│  │  cortana_self_model ── health_score · throttle_tier · alerts       │     │
│  │  Auto-throttle: Tier 0-3 based on budget burn rate                 │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │              🛡️ Immune System (threat detection & auto-healing)     │     │
│  │                                                                     │     │
│  │  Every 15 min: Threat scan (reads proprioception + events)         │     │
│  │  Detect → Match playbook → Execute fix → Log incident              │     │
│  │  Tier 1: auto-fix silent · Tier 2: fix+notify · Tier 3: quarantine│     │
│  │  Antibody memory: track incidents, auto-resolve repeat threats     │     │
│  │                                                                     │     │
│  │  cortana_immune_incidents · cortana_immune_playbooks               │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  37+ recurring crons · self-healing · auto-updates · memory persistence      │
└──────┬───┬───────────┬───────────┬───────────┬───────────┬───────────────────┘
       │   │           │           │           │           │
       │   │     spawns│     spawns│     spawns│     spawns│
       │   │           ▼           ▼           ▼           ▼
  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
  │   Huragok    │ │   Monitor    │ │  Librarian   │ │    Oracle    │
  │  (Research)  │ │  (Patterns)  │ │ (Knowledge)  │ │ (Forecasts)  │
  │              │ │              │ │              │ │              │
  │ "Deep dive   │ │ "Why is my   │ │ "Save this   │ │ "Predict my  │
  │  NVDA before │ │  sleep worse │ │  research on │ │  recovery    │
  │  earnings"   │ │  on weekends"│ │  Fed policy" │ │  after trip" │
  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
                    The Covenant (on-demand sub-agents)
                                   │
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
           ▼                       ▼                       ▼
  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │   knowledge/     │  │   knowledge/     │  │   knowledge/     │
  │   research/      │  │   patterns/      │  │   predictions/   │
  └──────────────────┘  └──────────────────┘  └──────────────────┘
       │
       │ reads/writes
       ▼
┌──────────────────┐
│   PostgreSQL     │
│   cortana DB     │
│                  │
│ sitrep·insights  │
│ chief_model      │
│ event_stream     │
│ patterns·tasks   │
│ events·feedback  │
│ watchlist        │
└──────────────────┘
       ▲
       │ feeds data
       │
═══════╪══════════════════════════════════════════════════════════════
       │             EXTERNAL SERVICES
═══════╪══════════════════════════════════════════════════════════════
       │
  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │  Whoop   │  │  Tonal   │  │  Google  │  │  Social  │  │ Trading  │
  │          │  │          │  │          │  │          │  │ Advisor  │
  │recovery  │  │strength  │  │Gmail/Cal │  │ X/Twitter│  │          │
  │sleep/HRV │  │workouts  │  │Drive     │  │ bird CLI │  │ CANSLIM  │
  │strain    │  │programs  │  │Contacts  │  │          │  │ Alpaca   │
  │:8080     │  │:8080     │  │gog CLI   │  │          │  │backtester│
  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘

  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │  Yahoo   │  │Home Asst │  │  Amazon  │
  │ Finance  │  │          │  │          │
  │          │  │ browser  │  │ session  │
  │stocks    │  │ tab on   │  │ keep-    │
  │GLD/gold  │  │ :18800   │  │ alive    │
  └──────────┘  └──────────┘  └──────────┘
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
- Brain: gpt-5.3-codex (OpenAI primary; Claude Opus 4.6 fallback)
- Infrastructure: OpenClaw on Mac mini
- Awareness: SAE (Situational Awareness Engine) — unified world state across all domains
- Budget: $200/month OpenAI Pro (Anthropic fallback only)

**Recent developments (Feb 2026):**
- OpenClaw creator Peter Steinberger joined OpenAI to lead "next generation personal agents"
- Completed migration from Clawdbot to OpenClaw (Feb 6)
- Full Disk Access granted to OpenClaw for macOS TCC-protected folders
- Trading system Phase 2 complete: CANSLIM backtesting with Alpaca API integration
- Mexico trip completed (Feb 19-22): Full prep with packing, weather checks, Uber scheduling
- NFL learning curriculum built: 11 comprehensive docs for American football understanding
- Security audit completed: Secrets removed from git history, .gitignore hardened

**Current priorities (Feb 2026):**
- Master's program: HW 597 still pending completion
- Fitness: Week 8/12 of "12 Weeks to Jacked" program + REM sleep optimization
- Trading alerts: Phase 3 implementation for CANSLIM momentum alerts
- Upcoming travel: Punta Cana Mar 25-29 @ Paradisus Palma Real

---

## How It All Connects

This isn't a collection of features. It's one organism. Every piece feeds the next in a continuous loop: gather → reason → act → learn → adapt.

```
EXTERNAL SERVICES (Whoop, Tonal, Google, Yahoo, X)
    │
    ▼ (raw data)
SAE World State Builder (7AM/1PM/9PM)
    │
    ▼ (structured sitrep rows)
cortana_sitrep table
    │
    ▼ (diff + reason)
SAE Cross-Domain Reasoner (7:15/1:15/9:15)
    │
    ▼ (insights)
cortana_insights table ──→ Consolidated Briefs (7:30/7:45/8:00/8:30)
    │                              │
    │                              ▼ (delivered to Hamel via Telegram)
    │                              │
    │                      Hamel reacts/responds
    │                              │
    │                              ▼
    │                      Feedback Loop
    │                      (reactions, behavioral, corrections)
    │                              │
    │                              ▼
    │                      cortana_feedback_signals
    │                              │
    │                              ▼
    │                      Evaluator adjusts wake rule weights
    │                              │
    ▼                              ▼
Cortical Loop (24/7)         Learning Loop (daily 11PM)
Signal Watchers ──→              │
Event Stream ──→ Evaluator ──→ writes to AGENTS.md / MEMORY.md
Chief Model ──→                  │
Wake Rules ──→                   ▼
    │                    Cortana's behavior changes
    ▼
LLM Wake (only when it matters)
    │
    ▼
Cortana acts with full context
                                       ▲
Proprioception (24/7, $0)              │ throttle tier
Cron health ──→ Self-Model ──→ cortana_self_model
Tool health ──→ (aggregator)           │
Budget track ──→    │                  ▼
                    └──→ Auto-Throttle (budget guard)
                                       │
Immune System (every 15 min)           │ feeds health data
Threat Detector ──→ Playbook Match ──→ Execute/Quarantine
    ↑ reads                                │
    │ cortana_self_model                   ▼
    │ cortana_cron_health          cortana_immune_incidents
    │ cortana_tool_health          cortana_immune_playbooks
    │ cortana_events               (antibody memory)
```

### The Full Cycle, Concrete

**7:00 AM — World State Builder fires.** It calls Whoop (recovery: 93%), checks Gmail (2 unread — one from professor), pulls calendar (HW due tomorrow, dentist at 2PM), grabs weather (42°F, rain PM), queries portfolio (TSLA +2.3%), reads pending tasks (3 open). All of this lands as structured JSONB rows in `cortana_sitrep`, tagged with a shared `run_id` UUID. If any source fails (Whoop API down?), it logs an error row and keeps going. Never aborts.

**7:15 AM — Cross-Domain Reasoner reads the sitrep.** It loads the current run *and* the previous run, diffs them, and looks for cross-domain signals. It notices: Mexico trip in 2 days + packing task still pending + weather forecast at destination says 75°F. Insight generated: "Pack light — warm weather, trip imminent" (priority 3, type: convergence). It also notices recovery dropped from 93% to 58% + you have a Tonal workout scheduled → insight: "Consider lighter session — recovery tanked overnight" (priority 2, type: conflict). Priority 1-2 insights get pushed to Telegram immediately. Priority 3-5 wait for the briefs.

**7:30 AM — Morning Brief pulls from sitrep.** Instead of independently calling 8 different APIs (the old way, ~$0.15/run), it reads `cortana_sitrep_latest` and `cortana_insights` where `acted_on = FALSE`. Weather? Already in sitrep. Calendar? Already there. It composes the brief, marks consumed insights as `acted_on = TRUE`, and delivers to Telegram. Token savings: ~60-70%.

**Meanwhile, 24/7 — the Cortical Loop is running.** The email watcher (every 2 min) detects a new email from your professor. It inserts an event into `cortana_event_stream`: `{source: "email", event_type: "new_unread", payload: {from: "prof@rutgers.edu", subject: "HW3 Extension"}}`. Five minutes later, the evaluator picks it up. It checks: does any wake rule match `source=email, event_type=new_unread`? Yes — `urgent_email` (priority 2, weight 1.0). It checks suppress conditions: Chief state is "awake" (not "asleep"), so no suppression. It checks the daily wake cap: 3/10 used today. **Wake triggered.** The evaluator builds a full-context prompt with the event, the Chief Model (awake, medium energy, personal mode), the latest sitrep, and recent feedback rules. It fires `openclaw cron wake` and Cortana acts — messages you about the extension with appropriate tone.

**You react 👎 to a late-night bedtime ping.** The feedback handler catches it. It maps the reaction to the `late_night_activity` rule. Weight drops from 1.0 to 0.85 (delta: -0.15). `negative_feedback` counter increments. Two more 👎s and the weight hits 0.55, then 0.40. One more and it's below 0.3 — the evaluator starts skipping it. If `negative_feedback` hits 3+ *and* weight < 0.3, auto-suppress fires: the rule is disabled, an event is logged, and Cortana tells you: "⚠️ Auto-suppressed wake rule 'late_night_activity' — got 3+ negative reactions. Re-enable anytime."

**11:00 PM — Learning Loop runs.** It processes all unapplied `cortana_feedback` entries (direct corrections like "don't ping me about bedtime"). If a correction maps to a wake rule name, it generates a feedback signal with -0.15 delta. It checks for repeated lessons: same correction 3+ times in 30 days? That means the rule isn't sticking — it escalates, alerts you, and asks if it should write it into `SOUL.md` for permanent reinforcement. Finally, it applies weight decay (-0.02) to any rule that triggered today but got zero engagement (no 👍, no 👎, nothing — you didn't care enough to react).

**Meanwhile, 24/7 — Proprioception monitors Cortana herself.** Every 15 minutes, shell-based probes check cron health (are all 27+ crons running? any silent failures?) and tool availability (PostgreSQL, Whoop, Tonal, Gmail, weather — all smoke-tested with timeouts). Every 30 minutes, the budget tracker computes spend-to-date, burn rate, and projected monthly cost, then the self-model writer aggregates everything into `cortana_self_model` — a single-row health dashboard. Health score: 100 minus penalties for down tools (-10 each), failing crons (-5), missed crons (-15), throttle tier, and budget overrun. If projected spend crosses 50%/75%/90% of the $200 budget, auto-throttle kicks in: Tier 1 (conservative) reduces non-essential cron frequency and switches Covenant to haiku. Tier 2 (austere) pauses informational crons entirely. Tier 3 (survival) kills everything except critical crons and forces all models to haiku. Throttle can only escalate automatically — de-escalation requires a new billing cycle or Hamel's manual override. At 2:30 AM daily, the efficiency analyzer computes per-cron token costs, sub-agent spawn rates, and brief engagement metrics. Total LLM cost of proprioception: $0. Everything is pure shell + SQL.

**3:00 AM — Memory Consolidation runs.** Cortana's sleep cycle. It scans the last 1-3 days of `memory/YYYY-MM-DD.md` files, cross-references `cortana_feedback`, `cortana_patterns`, and `cortana_tasks`, and distills the raw logs into long-term knowledge. A decision you made on Tuesday, a preference correction from Thursday, a behavioral pattern detected over the week — all extracted, strengthened in `MEMORY.md`, and the originals archived to `memory/archive/`. Stale entries get pruned — that completed task from 3 weeks ago, the flight that already happened. Then the Dream phase: creative cross-domain associations, the REM sleep equivalent. "You check your portfolio faster on high-recovery mornings." 0-3 dream insights per night, inserted into `cortana_insights` for the morning brief. The raw daily files move to archive; MEMORY.md gets sharper. Every night, Cortana wakes up knowing more and carrying less noise.

**The result:** Every day, Cortana gets slightly better at knowing what matters to you, when to speak up, and when to shut up. No manual tuning. The system tunes itself.

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

**Model:** Main session and automation use **gpt-5.3-codex** (OpenAI primary) with **Claude Opus 4.6** as fallback where configured.

**Location:** `covenant/` — each agent has SOUL.md (identity) + AGENTS.md (operations)

**Outputs go to:** `knowledge/` — research, patterns, predictions, indexed topics

---

## Cron Jobs

38+ recurring jobs run via OpenClaw's built-in cron scheduler. All times are Eastern. Manage with `openclaw cron list`.

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
  │    │    │    │ 9:30    │            12:30PM        3:30PM        │       8:30   │    │    │
  │    │    │    │ (wkdy)  │           (wkdy)         (wkdy)    (wkdy)   │      │    │    │
```

| Time (ET) | Job | What It Does |
|-----------|-----|--------------|
| 7:00 AM daily | ☀️ Morning Brief | News, weather, calendar, API usage |
| 7:30 AM weekdays | 📈 Stock Market Brief | Portfolio snapshot, material events |
| 8:00 AM daily | 🏋️ Fitness Morning Brief | Whoop recovery, sleep, readiness |
| 9:30 AM / 12:30 PM / 3:30 PM wkdy | 📈 CANSLIM Alert Scan | CANSLIM market scan with status summary + BUY/WATCH/NO_BUY candidate signals (Telegram) |
| 10:00 AM daily | 🔧 Daily Upgrade Protocol | Git auto-commit + self-improvement proposal |
| Every 30 min, 6AM–4PM | 📰 Newsletter Alert | Real-time newsletter detection |
| Hourly, 6AM–11PM | ⏰ Calendar Reminders | 60-min and 30-min event reminders (silent when nothing due) |
| 5 AM / 1 PM / 9 PM | 🖥️ Mac Mini Health | Process/resource summary |
| 6:00 PM weekdays | 📰 Newsletter Digest | End-of-day newsletter roundup |
| 8:30 PM daily | 🌙 Fitness Evening Recap | Strain, workout details, tomorrow's plan |
| 9:00 PM daily | 🔍 System Health Summary | Aggregate error/event analysis + cron run digest |
| 9:30 PM Fri/Sat | 🌙 Weekend Pre-Bedtime | REM drift prevention |
| 10:00 PM daily | 🌙 Bedtime Check | Sleep accountability ping |

### Healthchecks

| Frequency | Job | What It Does |
|-----------|-----|--------------|
| 4 AM / 4 PM | 🐦 X Session Healthcheck | Twitter auth validation |
| 4 AM / 4 PM | 🔧 Fitness Service Healthcheck | Port 8080 + auto-restart |
| Every 4h | 💪 Tonal Health Check | Auth validation + auto-retry |
| Every 8h | 🐦 Twitter Auth Check | Cookie/session validation |
| Every 8h | 🛒 Amazon Session Keep-Alive | Browser session check |

### Proprioception (Self-Monitoring)

| Frequency | Job | What It Does |
|-----------|-----|--------------|
| Every 15 min | 🔍 Cron & Tool Health | Cron state checks + tool smoke tests + self-heal |
| Every 30 min | 📊 Budget & Self-Model | Budget tracking + health score + auto-throttle |
| 2:30 AM daily | 📈 Efficiency Analyzer | Per-cron costs, engagement metrics, spending trends |

### Immune System

| Frequency | Job | What It Does |
|-----------|-----|--------------|
| Every 15 min | 🛡️ Immune Scan | Threat detection, playbook execution, quarantine, escalation |

### Maintenance

| Time (ET) | Job | What It Does |
|-----------|-----|--------------|
| 3:00 AM daily | 🧠 Memory Consolidation | Process daily memories → MEMORY.md, archive old files |
| 2:00 AM daily | 🧹 Cron Session Cleanup | Delete bloated session files (>400KB) — runs before other 3 AM jobs |
| 4:00 AM daily | 🔄 Daily Auto-Update | Homebrew, OpenClaw, skills updates |

### Weekly

| Time (ET) | Job | What It Does |
|-----------|-----|--------------|
| 3:00 AM Sunday | 📦 Weekly Backup Sync | iCloud backup of configs |
| 3:00 AM Sunday | 🧠 Weekly Memory Consolidation | Archive + distill MEMORY.md |
| 6:00 PM Sunday | 🔮 Weekly Cortana Status | Self-reflection + improvement proposals |
| 8:00 PM Sunday | 📊 Weekly Fitness Insights | Coach-style weekly analysis |
| 9:00 PM Sunday | 📊 Weekly Monday Market Brief | Weekly portfolio P/L + earnings watch + US macro calendar |

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
- **Tonal:** 12 Weeks to Jacked (Week 8/12 as of Feb 2026)
- **Cardio:** Peloton treadmill
- **Focus:** REM optimization (chronically low at 9.4%, weekend schedule drift is main issue)
- **Recovery:** Much improved from 40% → 85-93% range consistently

---

## Portfolio

### Current Holdings (~$71k as of Feb 2026)

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

**Exposure:** 95% tech, 100% US. Diversification candidates under consideration: VXUS, UNH, ENB, MA, LLY, ICE.

### Rules
1. **TSLA and NVDA are forever holds** — never sell
2. Diversify by ADDING positions, not trimming
3. Goal: Add 5-8 new positions over time

**Full config:** `tools/portfolio/config.md`

---

## Task Board

Cortana's structured planning and execution system. Tasks are organized in epic → task → subtask hierarchy with dependency tracking and automatic execution via heartbeats.

**Status:** ✅ Live (conversation detection + heartbeat sweep + Telegram task commands + morning brief task summary).

### How It Works

```
Conversation/Event → Detect → Decompose → Plan → Execute → Report
```

1. **Detect** — Cortana picks up actionable items from conversations, calendar events, or patterns  
2. **Decompose** — Break into epic → tasks → subtasks with dependencies
3. **Plan** — Order by dependencies and deadlines
4. **Execute** — Spawn sub-agents or queue for heartbeat pickup
5. **Report** — Surface progress in Telegram (morning brief, on-demand)

### Telegram Commands (natural language)
- "Show me tasks" / "What's on the board?"
- "What's blocked?"
- "Show epics"
- "Task done: <id>" / "Mark task <id> complete"
- "Skip task: <id>"
- "Add task: <description>"
- "What's due today?" / "Today's priorities?"
- "What can you do now?" / "Ready tasks?"
- "Show task counts" / "Task board counts" (status + priority breakdown)
- "Task summary" / "Quick task summary" (active count + top tasks)

Helper CLI for local ops/testing: `tools/task-board/task-board.sh`  
Examples: `task-board.sh counts` (status/priority totals), `task-board.sh summary` (active count + top 5 active tasks).

### Schema

**cortana_epics** — High-level projects with deadlines
- Epic → collection of related tasks (e.g., "Mexico Trip Prep", "Q1 Portfolio Review")
- Source: conversation, calendar, pattern, manual
- Status: active, completed, cancelled

**cortana_tasks** — Individual actionable items
- Can belong to an epic (`epic_id`) or be standalone
- Can have subtasks (`parent_id` → self-reference)
- Can depend on other tasks (`depends_on` → int array)
- Can be assigned to sub-agents (`assigned_to`)
- Status: pending, blocked, in_progress, done, cancelled

### Task Creation Sources

| Source | How Tasks Get Created |
|--------|----------------------|
| **Conversation** | "I need to prep for Mexico trip" → Cortana detects multi-step work |
| **Calendar** | Events with prep needed → auto-generate tasks |
| **Patterns** | Recurring behaviors → suggested task automation |
| **Manual** | Direct SQL INSERT or Telegram command |

### Execution Flow

During heartbeats, Cortana checks for dependency-ready tasks:

```sql
-- Find next executable task
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
```

**Execution rules:**
- Always spawn sub-agents for task execution (heartbeats dispatch, don't do)
- Sub-agents update task status and outcome when complete
- Dependencies block execution until all prerequisite tasks are 'done'
- Overdue reminders (`remind_at`) surface to Hamel during briefs

### Key Queries

```sql
-- View active epics with task counts
SELECT e.title, e.deadline, e.status, COUNT(t.id) as tasks
FROM cortana_epics e 
LEFT JOIN cortana_tasks t ON e.id = t.epic_id 
WHERE e.status = 'active'
GROUP BY e.id ORDER BY e.deadline;

-- Show task dependencies
SELECT t1.title as task, t2.title as depends_on
FROM cortana_tasks t1
JOIN cortana_tasks t2 ON t2.id = ANY(t1.depends_on)
WHERE t1.status IN ('pending', 'blocked')
ORDER BY t1.priority;

-- Find blocked tasks
SELECT title, priority, created_at
FROM cortana_tasks 
WHERE status = 'pending' 
  AND depends_on IS NOT NULL 
  AND EXISTS (
    SELECT 1 FROM cortana_tasks t2 
    WHERE t2.id = ANY(cortana_tasks.depends_on) 
    AND t2.status != 'done'
  );
```

### Example Structure

```
Epic: "Mexico Trip Prep" (deadline: Feb 19 6:39 AM)
├── Task: Check weather in Mexico City → done
├── Task: Generate packing list (depends on: weather) → done  
├── Task: Confirm Uber to EWR → done (cron set)
├── Task: International phone plan → pending
└── Task: Pesos / cash → pending
    └── Subtask: Check exchange rates → pending
    └── Subtask: Find nearby exchange → pending
```

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
│   ├── heartbeat-state.json
│   └── archive/           ← Consolidated daily files (YYYY/MM/)
│
├── memory-consolidation/  ← Sleep cycle system
│   ├── README.md          ← Full design doc
│   └── consolidation-prompt.md
│
├── proprioception/        ← Self-awareness & auto-throttle
│   ├── README.md          ← Full design doc
│   └── schema.sql         ← PostgreSQL table definitions
│
├── immune-system/         ← Threat detection & auto-healing
│   ├── README.md          ← Full design doc
│   ├── schema.sql         ← PostgreSQL table definitions
│   ├── seed-playbooks.sql ← Initial playbook entries
│   └── immune-scan-prompt.md ← Cron task prompt
│
├── skills/                ← Installed capabilities (14 skills)
│   ├── auto-updater/      ← System updates
│   ├── bird/              ← Twitter/X
│   ├── caldav-calendar/   ← Calendar management
│   ├── clawddocs/         ← Documentation
│   ├── clawdhub/          ← Hub management
│   ├── fitness-coach/     ← Whoop/Tonal
│   ├── gog/               ← Google (Gmail, Calendar)
│   ├── markets/           ← Market status/holidays
│   ├── news-summary/      ← News briefings
│   ├── process-watch/     ← Process monitoring
│   ├── telegram-usage/    ← Usage tracking
│   └── weather/           ← Weather data
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

### Trading Advisor

CANSLIM-based trading advisor with backtesting. Location: `~/Developer/cortana-external/backtester/`

**Quick commands:**
- `/market` — check market regime (M factor)
- `/portfolio` — Alpaca account + positions
- `/analyze SYMBOL` — full CANSLIM analysis
- `/scan` — find opportunities

**Cron:** `📈 CANSLIM Alert Scan (market sessions)` (ID: `9d2f7f92-b9e9-48bc-87b0-a5859bb83927`) runs 3x daily on weekdays (9:30 AM, 12:30 PM, 3:30 PM ET) and sends Telegram alerts with market status + buy/no-buy decisions.

---

## Situational Awareness Engine (SAE)

Cortana's world-state system. Gathers data from every source into a unified sitrep table, reasons across domains, and feeds consolidated briefs. Zero-LLM-cost data layer.

**Phases:** Phase 1 (world state builder) ✅ → Phase 2 (cross-domain reasoner) ✅ → Phase 3 (consolidated briefs) ✅ → Phase 4 (prediction + automation)

### Data Sources (9 Domains)

| # | Domain | Key(s) | How It's Gathered |
|---|--------|--------|-------------------|
| A | `calendar` | `events_48h`, `next_event` | `gog --account hameldesai3@gmail.com calendar events <cal_id> --from today --to +2d --json` |
| B | `email` | `unread_summary` | `gog --account hameldesai3@gmail.com gmail search 'is:unread' --max 10 --json` |
| C | `weather` | `today`, `tomorrow` | Web search for Warren, NJ conditions + forecast |
| D | `health` | `whoop_recovery`, `whoop_sleep`, `tonal_health` | `curl -s localhost:8080/whoop/data \| jq` + `curl -s localhost:8080/tonal/health` |
| E | `finance` | `stock_TSLA`, `stock_NVDA`, `stock_QQQ`, `stock_GLD` | `cd ~/clawd/skills/stock-analysis && uv run src/stock_analysis/main.py analyze SYMBOL --json` |
| F | `tasks` | `pending` | `SELECT json_agg(t) FROM cortana_tasks WHERE status='pending' ORDER BY priority LIMIT 10` |
| G | `patterns` | `recent_7d` | `SELECT json_agg(t) FROM cortana_patterns WHERE timestamp > NOW()-'7 days'` |
| H | `watchlist` | `active_items` | `SELECT json_agg(t) FROM cortana_watchlist WHERE enabled=TRUE` |
| I | `system` | `recent_errors` | `SELECT json_agg(t) FROM cortana_events WHERE severity='error' AND timestamp > NOW()-'24h'` |

Each run shares a `run_id` UUID. If any source fails, an error row is inserted and the run continues — never aborts.

### cortana_sitrep Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | Auto-increment |
| `timestamp` | timestamptz | Default `now()` |
| `run_id` | uuid | Groups all rows from one run |
| `domain` | text | Source domain (calendar, email, health, etc.) |
| `key` | text | Specific data point within domain |
| `value` | jsonb | The actual data |
| `ttl` | interval | Default 24h — how long this data is "fresh" |

**Indexes:** `(run_id, domain, key)` UNIQUE, `domain`, `run_id`, `timestamp DESC`

**View:** `cortana_sitrep_latest` — always returns the most recent value for each `(domain, key)` pair. This is what briefs and the evaluator read.

```sql
SELECT domain, key, substring(value::text, 1, 100) FROM cortana_sitrep_latest ORDER BY domain;
```

### Cross-Domain Reasoner

Runs 15 minutes after each World State Builder (7:15, 1:15, 9:15 ET). Loads current + previous sitrep, diffs them, and generates 2-5 high-quality cross-domain insights.

#### cortana_insights Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | Auto-increment |
| `timestamp` | timestamptz | Default `now()` |
| `sitrep_run_id` | uuid | Links back to the sitrep run that triggered this |
| `insight_type` | text | `convergence`, `conflict`, `anomaly`, `prediction`, `action` |
| `domains` | text[] | Which domains contributed (e.g. `{health, calendar}`) |
| `title` | text | Short headline |
| `description` | text | Full reasoning — what was noticed and why it matters |
| `priority` | integer | 1 (critical) to 5 (info) |
| `action_suggested` | text | Concrete next step, or NULL |
| `acted_on` | boolean | Marked TRUE after a brief consumes it |
| `acted_at` | timestamptz | When it was consumed |

#### The 5 Detection Patterns

| Pattern | What It Detects | Example |
|---------|----------------|---------|
| **Convergence** | Multiple signals pointing to one action | Trip in 2 days + packing task pending + destination weather 75°F → "Pack light, trip imminent" |
| **Conflict** | Contradictory signals | Early meeting tomorrow + poor sleep score → "Prep caffeine, you'll be dragging" |
| **Anomaly** | Significant change from previous run | TSLA dropped 5% since last sitrep → "Position moved sharply, check news" |
| **Prediction** | Pattern-based forecast | You always check portfolio after morning brief → pre-load the data |
| **Action** | Concrete overdue/due items | Task due today + calendar is packed → "Prioritize: HW due tonight, only 2h free" |

**Priority routing:** Priority 1-2 → immediately pushed to Telegram. Priority 3-5 → held for next brief. Briefs mark consumed insights `acted_on = TRUE` to prevent duplicates.

### Consolidated Briefs (Phase 3)

All 4 major daily briefs pull from sitrep + insights first, falling back to direct API calls only if data is stale (>4h):

| Brief | Time | Sitrep Fields Used | Fresh Fetch Only |
|-------|------|--------------------|------------------|
| ☀️ Morning | 7:30 AM | weather, calendar, email, health, finance, tasks | News/RSS, API usage |
| 📈 Stock Market | 7:45 AM wkdy | finance.* | Fresh prices if stale >2h |
| 🏋️ Fitness AM | 8:00 AM | health.* | Fresh Whoop if stale >2h |
| 🌙 Fitness PM | 8:30 PM | health.* | Fresh evening data (9PM SAE hasn't run yet) |

**Token savings:** ~60-70% reduction vs. independent data gathering. Previously each brief called 3-8 tools; now most data is pre-gathered.

### Morning Pipeline Timing

```
7:00  7:15  7:30  7:45  8:00                                8:30
  │     │     │     │     │                                    │
  ▼     ▼     ▼     ▼     ▼                                    ▼
 WSB  Reasoner ☀️Brief 📈Stock 🏋️Fitness AM              🌙Fitness PM
  │     │      reads   reads   reads                       reads
  │     │      sitrep  sitrep  sitrep                      sitrep
  │     │      + insights + insights + insights            + insights
  │     └──→ cortana_insights
  └──→ cortana_sitrep
```

**Files:** `sae/world-state-builder.md` (cron instructions), `sae/cross-domain-reasoner.md` (reasoning instructions), `sae/brief-template.md` (reusable template)

---

## Cortical Loop

Event-driven nervous system. The SAE gathers world state 3x/day on a schedule. The Cortical Loop fills the gaps — real-time signal detection, 24/7, at zero LLM cost until something actually matters.

**Cost:** Watchers + evaluator = $0 (pure bash, no LLM). Only pays for LLM on actual wake events. ~$15-30/month.

### Signal Watchers (6 Watchers)

All run as launchd LaunchAgents (`~/Library/LaunchAgents/com.cortana.watcher.*.plist`).

| Watcher | LaunchAgent | Interval | What It Monitors | Events Generated |
|---------|-------------|----------|------------------|------------------|
| 📧 `email-watcher.sh` | `com.cortana.watcher.email` | 2 min | Gmail unread via `gog` | `{source: "email", event_type: "new_unread"}` |
| 📅 `calendar-watcher.sh` | `com.cortana.watcher.calendar` | 5 min | Google Calendar via `gog` | `{source: "calendar", event_type: "event_approaching"}` |
| 💚 `health-watcher.sh` | `com.cortana.watcher.health` | 15 min | Whoop via localhost:8080 | `{source: "health", event_type: "recovery_update"}` |
| 📈 `portfolio-watcher.sh` | `com.cortana.watcher.portfolio` | 10 min | Stock prices (market hours only) | `{source: "finance", event_type: "price_alert"}` |
| 👤 `chief-state.sh` | `com.cortana.watcher.chief-state` | 5 min | Session files + calendar + sitrep | Updates `cortana_chief_model` directly |
| 🔍 `behavioral-watcher.sh` | `com.cortana.watcher.behavioral` | 30 min | Message latency, engagement | `cortana_feedback_signals` (implicit) |

Watchers INSERT events into `cortana_event_stream`. The chief-state watcher is special — it updates `cortana_chief_model` directly instead of creating events.

### cortana_event_stream Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | Auto-increment |
| `timestamp` | timestamptz | Default `now()` |
| `source` | varchar(50) | Which watcher produced this (email, calendar, health, finance, chief) |
| `event_type` | varchar(50) | What happened (new_unread, event_approaching, price_alert, etc.) |
| `payload` | jsonb | Event details (from address, price change %, event name, etc.) |
| `processed` | boolean | Default FALSE — evaluator sets TRUE after processing |
| `processed_at` | timestamptz | When the evaluator processed it |

**Index:** `(processed, timestamp) WHERE processed = FALSE` — fast lookup of unprocessed events.

### Chief Model (`cortana_chief_model`)

Real-time model of Hamel's state. Updated every 5 minutes by `chief-state.sh`. Zero LLM cost — pure inference from passive signals.

| Key | Example Value | How It's Inferred |
|-----|---------------|-------------------|
| `state` | `{"status": "awake", "confidence": 0.95}` | Last message <30 min ago → awake (0.95). 7AM-11PM + no recent msg → likely_awake (0.6). 11PM-7AM → likely_asleep (0.7) |
| `energy` | `{"level": "high", "recovery_score": 93}` | Whoop recovery from sitrep: ≥67 → high, 34-66 → medium, <34 → low |
| `focus` | `{"mode": "work", "in_meeting": false}` | Calendar overlap ±0 min → in_meeting. 9AM-5PM weekday → work. Else → personal |
| `communication_preference` | `{"style": "normal", "detail_level": "medium"}` | Low energy OR likely_asleep → brief/low. In meeting → minimal/minimal. Else → normal/medium |
| `location` | `{"place": "home", "traveling": false}` | Manually set or inferred from calendar |
| `active_priorities` | `[]` | Currently active priority items |
| `cortical_loop_enabled` | `"true"` | Kill switch — set to "false" to stop all wakes |
| `daily_wake_count` | `{"count": 3, "date": "2026-02-16", "max": 10}` | Resets daily. Auto-disables loop at max |

**Query:** `SELECT * FROM cortana_chief_model;`

**How communication adapts:**
- **Normal** (awake, decent energy, not in meeting): Full briefs, conversational tone
- **Brief** (low energy or likely asleep): Short messages, bullet points, essential info only
- **Minimal** (in a meeting): Only priority 1-2 events, one-line alerts

### Wake Rules (`cortana_wake_rules`)

7 configurable rules that determine what's worth waking the LLM for. Each rule matches `(source, event_type)` pairs from the event stream.

| Rule | Source | Event Type | Priority | Suppress When | What It Catches |
|------|--------|------------|----------|---------------|-----------------|
| `system_critical` | system | health_check | 1 | — | Infrastructure failures, service down |
| `urgent_email` | email | new_unread | 2 | Chief asleep | New unread emails |
| `calendar_soon` | calendar | event_approaching | 2 | — | Events starting soon (never suppressed) |
| `low_recovery_workout` | health | recovery_update | 2 | Chief asleep | Low recovery + workout scheduled |
| `portfolio_drop` | finance | price_alert | 2 | Chief asleep | Position dropped significantly |
| `portfolio_spike` | finance | price_alert | 3 | Chief asleep | Position spiked (lower urgency than drop) |
| `late_night_activity` | chief | late_activity | 4 | — | Chief still active past bedtime |

**Schema columns:** `name`, `description`, `source`, `event_type`, `condition` (jsonb), `priority` (1-5), `weight` (0.0-2.0, default 1.0), `enabled`, `suppress_when` (jsonb), `created_at`, `last_triggered`, `trigger_count`, `positive_feedback`, `negative_feedback`

### Evaluator Flow (`evaluator.sh`)

Runs every 5 minutes via `com.cortana.evaluator` LaunchAgent. Here's exactly what happens each cycle:

```
1. CHECK KILL SWITCH
   → cortana_chief_model WHERE key='cortical_loop_enabled'
   → If "false": exit immediately

2. CHECK DAILY WAKE CAP
   → cortana_chief_model WHERE key='daily_wake_count'
   → If date != today: reset count to 0
   → If count >= max (default 10): auto-disable loop, log event, exit

3. GET UNPROCESSED EVENTS
   → SELECT FROM cortana_event_stream WHERE processed = FALSE (limit 20)
   → If none: exit (nothing to evaluate)

4. GET CHIEF STATE
   → cortana_chief_model WHERE key='state' → awake/likely_awake/likely_asleep

5. GET ENABLED RULES
   → SELECT FROM cortana_wake_rules WHERE enabled = TRUE

6. MATCH EVENTS AGAINST RULES
   For each event × each rule:
   a. Does source + event_type match? → continue
   b. Is Chief state in suppress_when? → skip
   c. Is rule weight < 0.3? → skip (effectively suppressed)
   d. MATCH → add to wake events, increment rule trigger_count
   e. Mark event as processed regardless of match

7. IF WAKE EVENTS EXIST:
   a. Load full Chief Model (all 8 keys)
   b. Load cortana_sitrep_latest (full world state)
   c. Load recent cortana_feedback (last 5 applied lessons)
   d. Build wake prompt with all context
   e. Increment daily_wake_count
   f. Log cortical_wake event
   g. Fire: openclaw cron wake --text "$WAKE_PROMPT" --mode now

8. PROCESS FEEDBACK SIGNALS (always, even without wake events)
   → Calls feedback-handler.sh
```

### Kill Switch & Budget Guard

- **Manual toggle:** `bash ~/clawd/cortical-loop/toggle.sh`
- **Voice command:** "Kill the loop" / "Enable the loop"
- **Daily wake cap:** Default 10 wakes/day. When reached, loop auto-disables and logs a warning event.
- **Auto-reset:** Wake count resets to 0 at midnight ET.
- **Re-enable after budget:** Toggle the kill switch back on; count resets next day.

---

## Feedback Loop

The learning system. Cortana doesn't just act — she adapts. Three signal types feed into weight adjustments and behavioral changes.

### Three Signal Types

| Signal Type | Source | Weight Delta | Example |
|-------------|--------|-------------|---------|
| **Positive reaction** (👍 ❤️ 🔥) | Telegram reaction | +0.05 | You 👍 a morning portfolio alert → `portfolio_drop` rule reinforced |
| **Negative reaction** (👎 😒) | Telegram reaction | -0.15 | You 👎 a bedtime ping → `late_night_activity` weight drops |
| **No engagement** (2h+, no reaction) | behavioral-watcher | -0.02 | You ignore a recovery alert entirely → slow decay |
| **Quick reply** (<5 min) | behavioral-watcher | +0.05 | You reply fast to a calendar alert → `calendar_soon` reinforced |
| **Direct correction** ("stop X") | cortana_feedback table | -0.15 | "Stop pinging me about bedtime" → mapped to rule, weight drops |

### Weight Adjustment Math

```
new_weight = current_weight + delta
new_weight = max(0.1, min(2.0, new_weight))  # Floor 0.1, ceiling 2.0
```

- **+0.05 per positive** — slow reinforcement (it takes 20 positives to double a weight)
- **-0.15 per negative** — fast learning (3 negatives drops weight from 1.0 to 0.55)
- **-0.02 per no-engagement** — glacial decay (50 ignores to hit floor)
- **Threshold at 0.3** — evaluator skips rules below this weight (effectively muted, not dead)
- **Floor at 0.1** — rules never fully die; can always be re-enabled

### Auto-Suppress Mechanics

When all three conditions are met:
1. `negative_feedback >= 3`
2. `negative_feedback > positive_feedback`
3. `weight < 0.3`

The feedback handler:
1. Sets `enabled = FALSE` on the rule
2. Logs an `auto_suppress` event
3. Fires a wake to notify Hamel: "⚠️ Auto-suppressed rule 'X' — got 3+ negative reactions. Re-enable with: `UPDATE cortana_wake_rules SET enabled = TRUE, weight = 1.0, negative_feedback = 0 WHERE name = 'X';`"

### cortana_feedback_signals Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | Auto-increment |
| `timestamp` | timestamptz | Default `now()` |
| `signal_type` | varchar(20) | `positive`, `negative`, `no_engagement` |
| `source` | varchar(50) | `reaction`, `behavioral`, `learning_loop`, `manual` |
| `related_rule` | varchar(100) | Which wake rule this applies to (nullable) |
| `related_message_id` | text | The Telegram message that triggered this signal |
| `context` | text | Human-readable description |
| `processed` | boolean | Default FALSE — feedback-handler sets TRUE |
| `weight_delta` | float | The weight change to apply |

### Learning Loop Pipeline (Daily, 11 PM ET)

`learning-loop.sh` runs via `com.cortana.learning-loop` LaunchAgent.

**Step 1: Process unapplied feedback.** Reads `cortana_feedback WHERE applied = FALSE`. For each entry, checks if the lesson text matches a wake rule name. If so, generates a feedback signal with -0.15 delta. Marks feedback as applied.

**Step 2: Repeated lesson detection.** Queries feedback for same `(feedback_type, lesson)` appearing 3+ times in 30 days. If found:
- Logs a `learning_escalation` event (severity: warning)
- Wakes the LLM to alert Hamel: "🔄 These lessons aren't sticking: [list]. Should I add them to SOUL.md or strengthen the rules?"
- This is the 3x escalation — if Cortana keeps making the same mistake, it's not a one-off, it's a structural problem.

**Step 3: Engagement decay.** Finds rules that triggered in the last 24h but got zero feedback signals. Applies -0.02 weight decay to each. If you didn't react at all — not positively, not negatively — the signal probably wasn't worth waking you for.

### cortana_feedback Schema (Direct Corrections)

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | Auto-increment |
| `timestamp` | timestamptz | Default `now()` |
| `feedback_type` | varchar(50) | `correction`, `preference`, `fact`, `behavior`, `tone` |
| `context` | text | What happened that triggered the correction |
| `lesson` | text | The rule learned |
| `applied` | boolean | Whether the learning loop has processed this |

---

## Memory Consolidation

Cortana's sleep cycle. Every night at 3 AM ET, raw daily memories are processed into long-term knowledge — like biological memory consolidation during deep sleep.

### The 7 Phases

```
memory/YYYY-MM-DD.md (last 1-3 days)
    │
    ▼
 Review → Distill → Strengthen → Prune → Connect → Archive → Dream
 (scan)   (extract)  (update     (remove   (xref    (move old  (creative
           insights)  MEMORY.md)  stale)    DB)      files)     connect)
    │                    │                    │          │
    ▼                    ▼                    ▼          ▼
 cortana_feedback   MEMORY.md           memory/    cortana_insights
 cortana_patterns   (updated)           archive/   (dream type)
 cortana_tasks
```

| Phase | What It Does |
|-------|-------------|
| **Review** | Scan unconsolidated daily files + query `cortana_feedback`, `cortana_patterns`, `cortana_events`, `cortana_tasks` |
| **Distill** | Extract decisions, lessons, preferences, patterns, project state. Discard routine heartbeats, transient data |
| **Strengthen** | Update `MEMORY.md` — add new entries, reinforce confirmed patterns, merge duplicates |
| **Prune** | Remove completed one-off tasks, stale context (>30 days), superseded preferences. Log everything pruned |
| **Connect** | Cross-reference DB for feedback clusters (same correction 3+ times = rule not strong enough). Surface overdue tasks |
| **Archive** | Move consolidated files older than 3 days to `memory/archive/YYYY/MM/`. Preserve as-is |
| **Dream** | Creative associations — find cross-domain correlations, non-obvious insights. 0-3 dream insights per run |

### Integration With Other Systems

- **→ SAE:** Dream insights land in `cortana_insights`, surfaced in morning brief's 🧠 section
- **→ Cortical Loop:** Strengthened MEMORY.md rules improve wake response quality; archived files reduce heartbeat noise
- **→ Feedback Loop:** Reviews `cortana_feedback` for repeated corrections; auto-suppressed rules get reviewed during Connect

### cortana_memory_consolidation Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | Auto-increment |
| `run_id` | uuid | Unique run identifier |
| `started_at` | timestamptz | Run start time |
| `completed_at` | timestamptz | Run completion time |
| `status` | text | `running`, `completed`, `failed` |
| `days_reviewed` | text[] | Which daily files were processed |
| `items_distilled` | int | Items extracted from raw logs |
| `items_strengthened` | int | MEMORY.md entries added/reinforced |
| `items_pruned` | int | Stale entries removed |
| `items_archived` | int | Daily files moved to archive |
| `dream_insights` | int | Creative insights generated |
| `feedback_clusters` | jsonb | Repeated correction themes found |
| `summary` | text | Human-readable run summary |

**Files:** `memory-consolidation/README.md` (full design), `memory-consolidation/consolidation-prompt.md` (cron prompt)

---

## Proprioception

Cortana's self-awareness system. Maintains a real-time model of her own health, budget, and operational state — the way a body knows where its limbs are without looking. Total LLM cost: **$0**. Everything is pure shell + SQL.

### Components

| Component | Interval | What It Does |
|-----------|----------|--------------|
| **Cron Health Monitor** | Every 15 min | Checks each cron's last run time, exit status, consecutive failures. Flags silent failures (lastRun > 2× expected interval) |
| **Tool Health Prober** | Every 15 min | Smoke-tests PostgreSQL, Whoop, Tonal, Gmail, Weather with timeouts. Self-heals when possible |
| **Budget Tracker** | Every 30 min | Computes spend-to-date, burn rate, projected monthly spend, per-category breakdown |
| **Self-Model Writer** | Every 30 min | Aggregates all data into `cortana_self_model` — single-row health dashboard |
| **Efficiency Analyzer** | Daily 2:30 AM | Token cost per cron, top 5 expensive crons, sub-agent spawn rate, brief engagement rate |
| **Auto-Throttler** | With self-model | Escalates throttle tier (0-3) when budget thresholds crossed |

### Auto-Throttle Tiers

| Tier | Trigger | Actions |
|------|---------|---------|
| **0 — Normal** | Budget < 50%, projected < $180 | All systems nominal |
| **1 — Conservative** | Budget > 50% OR projected > $180 | Covenant → haiku. Non-essential crons reduce frequency |
| **2 — Austere** | Budget > 75% OR projected > $190 | Disable Covenant (except Monitor). Informational crons pause |
| **3 — Survival** | Budget > 90% OR projected > $198 | Only critical crons run. All models → haiku. No sub-agent spawns |

Throttle can only **increase** automatically. Decrease requires next billing cycle or manual override.

### Health Score

```
health = 100
  - (10 × tools_down)
  - (5  × crons_failing)
  - (15 × crons_missed)
  - throttle_penalty (tier 1: -5, tier 2: -15, tier 3: -30)
  - budget_penalty (>75%: -5, >90%: -15)

Status: ≥80 nominal · 50-79 degraded · <50 critical
```

### Integration

- **→ SAE:** Self-model feeds into sitrep's "system" domain. Morning brief gains ⚙️ System Health section when status ≠ nominal
- **→ Cortical Loop:** Health degradation events can trigger LLM wake for intelligent response
- **→ Memory Consolidation:** Reviews throttle and cron health logs for patterns worth remembering
- **← Watchdog:** Active external service at `~/Developer/cortana-external/watchdog` (launchd `com.cortana.watchdog`)

**Files:** `proprioception/README.md` (full design), `proprioception/schema.sql` (table definitions)

---

## Immune System

Cortana's self-defense layer. Detects threats (credential failures, API errors, budget burns, silent cron deaths), matches them against known playbooks, executes fixes, and escalates when needed. Builds antibody memory so repeat threats are resolved faster — or automatically.

### Components

| Component | What It Does |
|-----------|--------------|
| **Threat Detector** | Scans `cortana_events`, `cortana_tool_health`, `cortana_cron_health`, `cortana_self_model` for active issues |
| **Playbook Executor** | Matches threats against `cortana_immune_playbooks` and executes known fixes |
| **Quarantine** | Isolates runaway components (suspend crons, stop services) before cascade |
| **Antibody Memory** | Logs every incident in `cortana_immune_incidents`. Repeat threats auto-resolve via saved playbooks |
| **Escalation Router** | Routes responses: Tier 1 (silent fix), Tier 2 (fix + notify), Tier 3 (quarantine + alert Chief) |

### Escalation Tiers

| Tier | Criteria | Response |
|------|----------|----------|
| **1 — Auto-fix** | Known playbook, low severity | Execute silently, log incident |
| **2 — Fix + Notify** | Medium severity or first occurrence | Fix + Telegram: "🛡️ Fixed: [issue]" |
| **3 — Quarantine + Alert** | High severity, cascade risk, unknown threat | Quarantine + "🚨 [threat] — [component] quarantined" |

### Built-In Playbooks

| Playbook | Trigger | Action | Tier |
|----------|---------|--------|------|
| `tonal_token_reset` | Tonal auth failure | Delete token, restart service | 1 |
| `session_cleanup` | Session files >400KB | Delete bloated files | 1 |
| `fitness_service_restart` | Port 8080 down | Restart fitness service | 1 |
| `browser_restart` | Port 18800 down | Restart OpenClaw browser | 1 |
| `cron_unstick` | Cron missed 3+ runs | Check for stuck process, alert | 2 |
| `runaway_cron` | Cron burning 10× normal tokens | Suspend cron, alert Chief | 3 |
| `tool_cascade` | 3+ tools down simultaneously | Quarantine non-essentials, alert | 3 |

### Integration

- **← Proprioception:** Reads health data from `cortana_self_model`, `cortana_cron_health`, `cortana_tool_health` — detects, doesn't duplicate
- **← Cortical Loop:** Reads `cortana_events` for error patterns. Tier 3 alerts trigger LLM wake
- **→ Memory Consolidation:** Nightly review of `cortana_immune_incidents` for recurring patterns
- **→ SAE/Morning Brief:** Active incidents surface in morning brief's 🛡️ Immune Status section

### Cron

| Frequency | Job | Cost |
|-----------|-----|------|
| Every 15 min | 🛡️ Immune Scan | ~$0.02/run (codex, only when threats detected) |

**Files:** `immune-system/README.md` (full design), `immune-system/schema.sql`, `immune-system/seed-playbooks.sql`

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
| `cortana_epics` | Project/epic grouping for task hierarchy |
| `cortana_memory_consolidation` | Nightly memory consolidation run log |
| `cortana_self_model` | Proprioception self-model (singleton health dashboard) |
| `cortana_budget_log` | Budget tracking over time (spend, burn rate, projected) |
| `cortana_cron_health` | Cron health history (status, failures, duration) |
| `cortana_tool_health` | Tool availability history (up/down, response time, self-heal) |
| `cortana_throttle_log` | Auto-throttle tier change events |
| `cortana_feedback_signals` | Reaction/behavioral/correction signals for weight adjustment |
| `cortana_immune_incidents` | Immune System incident log (threats, resolutions, quarantines) |
| `cortana_immune_playbooks` | Immune System playbook registry (known fix patterns) |
| `cortana_sitrep` | SAE world state snapshots (domain/key/value) |
| `cortana_insights` | SAE cross-domain reasoner insights |
| `cortana_chief_model` | Real-time Chief state model (awake/asleep, energy, focus) |
| `cortana_event_stream` | Cortical Loop event bus from watchers |
| `cortana_wake_rules` | Weighted rules for LLM wake decisions |

**Access:**
```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana -c "SELECT * FROM cortana_covenant_runs;"
```

---

## Budget

**Monthly:** $200 OpenAI Pro (primary) with Anthropic as fallback only

| Component | ~Monthly Cost |
|-----------|---------------|
| Main chat | $70-90 |
| Crons | $15-25 |
| Covenant agents | $20-30 |
| Buffer | $30-60 |

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

## Operations & Debugging

### System Health Checks

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

# Are all LaunchAgents running?
launchctl list | grep com.cortana

# Chief Model — what does Cortana think your state is?
psql cortana -c "SELECT * FROM cortana_chief_model;"

# Latest sitrep — is world state fresh?
psql cortana -c "SELECT domain, key, substring(value::text, 1, 100) FROM cortana_sitrep_latest ORDER BY domain;"

# Recent insights — what has the Reasoner noticed?
psql cortana -c "SELECT insight_type, title, priority, acted_on FROM cortana_insights ORDER BY timestamp DESC LIMIT 10;"

# Event stream — what signals are flowing?
psql cortana -c "SELECT source, event_type, processed, timestamp FROM cortana_event_stream ORDER BY timestamp DESC LIMIT 10;"

# Wake rule weights — are they drifting?
psql cortana -c "SELECT name, weight, trigger_count, positive_feedback, negative_feedback, enabled FROM cortana_wake_rules ORDER BY weight;"

# Feedback signals — what reactions have been processed?
psql cortana -c "SELECT signal_type, source, related_rule, weight_delta, processed FROM cortana_feedback_signals ORDER BY timestamp DESC LIMIT 10;"

# Watcher logs — any errors?
for f in ~/clawd/cortical-loop/logs/*.log; do echo "=== $(basename $f) ==="; tail -5 "$f"; done

# Kill switch status
psql cortana -c "SELECT value FROM cortana_chief_model WHERE key='cortical_loop_enabled';"

# Daily wake budget
psql cortana -c "SELECT value FROM cortana_chief_model WHERE key='daily_wake_count';"
```

### Common Fixes

| Problem | Diagnosis | Fix |
|---------|-----------|-----|
| Cortical Loop not waking | Kill switch off or wake cap hit | `psql cortana -c "SELECT value FROM cortana_chief_model WHERE key IN ('cortical_loop_enabled', 'daily_wake_count');"` → toggle or wait for reset |
| Watcher errors | Check logs | `tail -20 ~/clawd/cortical-loop/logs/<watcher>.log` |
| Rule never triggers | Weight suppressed by feedback | `SELECT name, weight, enabled FROM cortana_wake_rules WHERE name='rule_name';` → if weight < 0.3 or enabled=FALSE, re-enable |
| Sitrep stale | SAE cron didn't run | `openclaw cron list` → check lastRunAtMs for world-state-builder |
| Wake rule too sensitive | Triggers too often | `UPDATE cortana_wake_rules SET weight = 0.5 WHERE name = 'rule_name';` |
| Want to start fresh | Reset all weights | `UPDATE cortana_wake_rules SET weight = 1.0, positive_feedback = 0, negative_feedback = 0, enabled = TRUE;` |
| Re-enable suppressed rule | Was auto-suppressed | `UPDATE cortana_wake_rules SET enabled = TRUE, weight = 0.5 WHERE name = 'rule_name';` |
| Toggle Cortical Loop | On/off | `bash ~/clawd/cortical-loop/toggle.sh` |

### Manual Overrides

```bash
# Force SAE run (trigger cron manually)
openclaw cron run <world-state-builder-cron-id>

# Force LLM wake with custom message
openclaw cron wake --text "your message here" --mode now

# Manually log negative feedback for a rule
psql cortana -c "INSERT INTO cortana_feedback_signals (signal_type, source, related_rule, weight_delta)
  VALUES ('negative', 'manual', 'rule_name', -0.15);"

# Reset Chief Model state
psql cortana -c "UPDATE cortana_chief_model SET value = '{\"status\": \"awake\", \"confidence\": 0.5}' WHERE key = 'state';"

# Re-enable loop after budget guard disabled it
psql cortana -c "UPDATE cortana_chief_model SET value = '\"true\"' WHERE key = 'cortical_loop_enabled';"
```

### Database Tables Reference

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `cortana_sitrep` | SAE world state snapshots | `run_id`, `domain`, `key`, `value` (jsonb) |
| `cortana_insights` | Cross-domain reasoner insights | `insight_type`, `domains[]`, `title`, `priority`, `acted_on` |
| `cortana_chief_model` | Real-time Chief state model | `key`, `value` (jsonb), `updated_at`, `source` |
| `cortana_event_stream` | Real-time event bus from watchers | `source`, `event_type`, `payload` (jsonb), `processed` |
| `cortana_wake_rules` | Weighted rules for LLM wake decisions | `name`, `source`, `event_type`, `priority`, `weight`, `enabled` |
| `cortana_feedback_signals` | Reaction/behavioral/correction signals | `signal_type`, `related_rule`, `weight_delta`, `processed` |
| `cortana_feedback` | Direct corrections & lessons learned | `feedback_type`, `context`, `lesson`, `applied` |
| `cortana_tasks` | Autonomous task queue | `title`, `priority`, `status`, `due_at`, `auto_executable` |
| `cortana_events` | System events & error log | `event_type`, `source`, `severity`, `message`, `metadata` (jsonb) |
| `cortana_patterns` | Behavioral pattern tracking | `pattern_type`, `value`, `day_of_week`, `metadata` (jsonb) |
| `cortana_watchlist` | Active monitoring items | `category`, `item`, `condition`, `threshold`, `last_value` |
| `cortana_upgrades` | Self-improvement proposals | `gap_identified`, `proposed_fix`, `effort`, `status` |
| `cortana_memory_consolidation` | Nightly memory consolidation run log | `run_id`, `days_reviewed`, `items_distilled`, `items_pruned`, `status` |
| `cortana_self_model` | Proprioception health dashboard (singleton) | `health_score`, `status`, `throttle_tier`, `budget_pct_used`, `alerts[]` |
| `cortana_budget_log` | Budget tracking history | `spend_to_date`, `burn_rate`, `projected`, `breakdown` (jsonb) |
| `cortana_cron_health` | Cron health history | `cron_name`, `status`, `consecutive_failures`, `run_duration_sec` |
| `cortana_tool_health` | Tool availability history | `tool_name`, `status`, `response_ms`, `error`, `self_healed` |
| `cortana_throttle_log` | Auto-throttle events | `tier_from`, `tier_to`, `reason`, `actions_taken[]` |
| `cortana_immune_incidents` | Immune System incident log | `threat_type`, `source`, `severity`, `tier`, `status`, `playbook_used` |
| `cortana_immune_playbooks` | Immune System playbook registry | `name`, `threat_signature`, `actions` (jsonb), `tier`, `success_rate` |

### LaunchAgents

All Cortical Loop services run as macOS LaunchAgents:

| Service | Plist | Interval |
|---------|-------|----------|
| Evaluator | `com.cortana.evaluator` | Every 5 min |
| Learning Loop | `com.cortana.learning-loop` | Daily 11 PM ET |
| Watchdog | `com.cortana.watchdog` | Every 15 min |
| Email Watcher | `com.cortana.watcher.email` | Every 2 min |
| Calendar Watcher | `com.cortana.watcher.calendar` | Every 5 min |
| Health Watcher | `com.cortana.watcher.health` | Every 15 min |
| Portfolio Watcher | `com.cortana.watcher.portfolio` | Every 10 min |
| Chief State Watcher | `com.cortana.watcher.chief-state` | Every 5 min |
| Behavioral Watcher | `com.cortana.watcher.behavioral` | Every 30 min |

```bash
# Check all are loaded
launchctl list | grep com.cortana

# Reload a specific agent
launchctl unload ~/Library/LaunchAgents/com.cortana.watcher.email.plist
launchctl load ~/Library/LaunchAgents/com.cortana.watcher.email.plist
```

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

*Last updated: 2026-02-19*
