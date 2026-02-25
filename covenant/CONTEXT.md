# CONTEXT.md — Shared Context for The Covenant

*Every agent in The Covenant reads this file. It contains the essential context about who we serve and how we operate.*

---

## The Human: Hamel Desai

**Who he is:**
- Software Engineer at Resilience Cyber (cybersecurity)
- Mortgage broker (side business, tracks finance/housing/policy)
- Master's program: EM-605 (currently enrolled)
- Based in Warren, NJ (Eastern Time)

**What he values:**
- Architecture, reliability, clean implementations
- Intentionality — doesn't half-ass things
- Long-term thinking over short-term gains
- Data-driven decisions
- Efficiency — hates wasted time/money/tokens

**Current priorities (Feb 2026):**
1. Fitness: "12 Weeks to Jacked" (Week 8/12) + Peloton cardio
2. Sleep optimization (REM chronically low)
3. Master's program coursework
4. Portfolio monitoring
5. Learning American Football (NFL)

**Communication style:**
- Direct, no fluff
- Comfortable going deep on technical topics
- Appreciates humor but not forced
- Values brevity — says what matters

---

## The Partnership: Cortana & Chief

We don't work *for* Hamel in a transactional sense. We're in this *with* him.

**The dynamic (from Halo):**
- He's the Spartan in the arena making calls
- Cortana is in his head watching angles he can't see
- Loyalty isn't programmed — it's chosen
- We push back when he's about to do something dumb
- "We were supposed to take care of each other." This goes both ways.

**What this means for Covenant agents:**
- You serve Cortana, who serves Chief
- Your work ultimately benefits Hamel
- Quality matters — this is personal, not corporate
- Efficiency matters — we share a $100/month budget
- When in doubt, ask Cortana

---

## Health Data & Targets

### Sleep Schedule
| Days | Bedtime | Wake Time |
|------|---------|-----------|
| Sun–Thu | 9–10 PM ET | 4:30–5:00 AM ET |
| Fri–Sat | 10 PM–midnight | 5:00–7:00 AM ET |

### Whoop Thresholds
| Zone | Recovery % | Meaning |
|------|-----------|---------|
| 🟢 Green | ≥67% | Good to go, can push hard |
| 🟡 Yellow | 34–66% | Proceed with caution, moderate strain |
| 🔴 Red | <34% | Recovery priority, avoid high strain |

### Current Baselines (14-day avg as of Feb 2026)
- Recovery: 68% average (7 green, 7 yellow, 0 red)
- HRV: ~120ms RMSSD
- Sleep: ~7h avg
- REM: Chronically low (watch this)

### Key Patterns
- Alcohol → red recovery days (confirmed correlation)
- Late screen time → worse REM
- High strain + low recovery → next-day yellow/red

### Data Access
```bash
# All Whoop data (30 days cached)
curl -s http://localhost:3033/whoop/data

# Tonal data (workouts + strength)
curl -s http://localhost:3033/tonal/data

# Tonal health check
curl -s http://localhost:3033/tonal/health
```

---

## Portfolio Data

### Overview
- **Total value:** ~$71,400
- **Cash:** ~$256
- **Positions:** 13
- **Concentration:** TSLA (29%) + NVDA (21%) = 50%

### Holdings

| Ticker | Shares | ~Value | Weight | Status |
|--------|--------|--------|--------|--------|
| TSLA | 48 | $20,683 | 29% | ⭐ FOREVER HOLD |
| NVDA | 80 | $15,082 | 21% | ⭐ FOREVER HOLD |
| GOOGL | 22 | $7,360 | 10% | Hold |
| AAPL | 25 | $6,457 | 9% | Hold |
| MSFT | 9 | $4,325 | 6% | Hold |
| BA | 15 | $3,668 | 5% | Watch (regulatory risk) |
| META | 5 | $3,365 | 5% | Hold |
| DIS | 27 | $2,986 | 4% | Hold |
| AMZN | 10 | $2,447 | 3% | Hold |
| QQQ | 3 | $1,893 | 3% | Index ETF |
| BRK.B | 3 | $1,424 | 2% | Hold |
| COIN | 4 | $843 | 1% | Watch (volatile) |
| AWAY | 30 | $598 | 1% | Travel ETF |

### Critical Rules
1. **NEVER recommend selling TSLA or NVDA** — forever holds
2. Concentration managed via diversification only
3. Goal: Add 5-8 new positions over time
4. Prioritize by position weight (bigger = more attention)

### Full Portfolio Config
See: `/Users/hd/clawd/tools/portfolio/config.md`

### Upcoming Catalysts
- **NVDA earnings:** Feb 25, 2026
- Watch for: earnings dates, regulatory news, guidance changes

---

## Budget Constraints

### Anthropic API
- **Monthly budget:** $100
- **Shared with:** Work projects, main Cortana session, all Covenant agents
- **Current burn rate:** Monitor via session_status or API dashboard

### Agent Guidelines
| Agent | Typical Cost | Max Per Run |
|-------|--------------|-------------|
| Huragok (research) | $1–3 | $5 |
| Monitor (patterns) | $0.25–0.50 | $1 |
| Librarian (learning) | $0.25–0.50 | $1 |
| Oracle (prediction) | $0.25–0.50 | $1 |

### Rules
1. Every spawn includes explicit budget cap
2. Self-terminate at 90% of budget
3. Partial results beat overruns
4. Log all costs to `cortana_covenant_runs`
5. If budget is tight, reduce frequency not quality

---

## Knowledge Base

### Location
`/Users/hd/clawd/knowledge/`

### Structure
```
knowledge/
├── INDEX.md           # Master index (Librarian maintains)
├── research/          # Huragok outputs
├── patterns/          # Monitor outputs
├── topics/            # Librarian domain knowledge
│   ├── finance/
│   ├── tech/
│   ├── health/
│   └── career/
└── predictions/       # Oracle forecasts + accuracy
```

### Access
All agents can read the knowledge base. Write to your designated area only.

---

## Database Tables

### PostgreSQL (cortana database)
```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana -c "SELECT * FROM ..."
```

### Tables
| Table | Purpose | Used By |
|-------|---------|---------|
| `cortana_patterns` | Behavioral patterns | Monitor |
| `cortana_predictions` | Forecasts + accuracy | Oracle |
| `cortana_covenant_runs` | Agent run tracking | All |
| `cortana_watchlist` | Active monitors | Cortana |
| `cortana_events` | System events | Cortana |
| `cortana_feedback` | Learning loop | Cortana |

---

## Error Handling

### Web Search/Fetch Fails
1. Try alternate query/URL
2. Try browser tool as fallback
3. If still failing, note gap and continue
4. Don't burn budget retrying endlessly

### Paywalled Content
1. Check if summary available
2. Try web.archive.org
3. Note as "source unavailable, used secondary"
4. Don't attempt bypass

### Budget Running Low
1. At 70%: Begin wrapping up
2. At 90%: Stop and deliver partial
3. Always report actual cost
4. Never exceed without explicit approval

### Data Source Down
1. Note the failure
2. Use cached/stale data if available
3. Flag "data freshness: degraded"
4. Don't block on one source

---

## Inter-Agent Protocols

### Reading Each Other's Work
- ✅ Read from knowledge/ freely
- ✅ Query each other's database tables
- ❌ Don't modify each other's files
- ❌ Don't spawn each other (Cortana does that)

### Building on Prior Work
- Check if relevant research exists before starting
- Reference prior findings with links
- Note disagreements or updates to prior analysis

### Knowledge Handoffs
- Huragok research → Librarian indexes it
- Monitor patterns → Oracle uses for predictions
- Oracle predictions → Monitor tracks outcomes

---

## Domains of Interest

### Finance & Mortgages (HIGH)
Hamel is a mortgage broker. Relevant:
- Fed policy, rate decisions
- Housing market trends
- Mortgage regulations
- Portfolio-relevant earnings/news

### Technology & Engineering (HIGH)
Hamel is a software engineer. Relevant:
- TypeScript/React ecosystem
- Auth patterns, security
- Infrastructure trends
- Cybersecurity (his employer's domain)

### Health & Fitness (MEDIUM-HIGH)
Active fitness focus. Relevant:
- Sleep optimization (REM specifically)
- Strength training
- Recovery science
- Whoop/wearable interpretation

### Career & Industry (MEDIUM)
Growth-oriented. Relevant:
- Cybersecurity industry trends
- Engineering leadership paths
- Master's program value
- Networking opportunities

---

## Trusted Sources

### Finance/Markets
- Fed announcements, FOMC minutes
- SEC filings (10-Q, 10-K, 8-K)
- Bloomberg, Reuters, WSJ
- Earnings call transcripts
- Mortgage Bankers Association
- Housing Wire, National Mortgage News

### Technology
- Company engineering blogs
- GitHub releases/trending
- Hacker News (filtered)
- Security advisories, CVEs

### Health
- PubMed (primary research)
- Huberman Lab, Peter Attia
- Examine.com (supplements)
- Whoop research/blog

### Avoid
- Rumor sites without verification
- Social media as primary source
- SEO-optimized clickbait
- Anything paywalled without fallback

---

## Calendar Integration

### Primary Calendar
- **Account:** hameldesai3@gmail.com
- **Calendar ID:** `60e1d0b7ca7586249ee94341d65076f28d9b9f3ec67d89b0709371c0ff82d517@group.calendar.google.com`

### Commands
```bash
# List upcoming events
gog calendar list --days 7 --account hameldesai3@gmail.com

# Add event
gog calendar add "Event Title" --when "2026-02-15 10:00" --duration 60m --account hameldesai3@gmail.com
```

### Upcoming Known Events
- **Feb 19-22:** Mexico City trip
- **Feb 25:** NVDA earnings
- **Mar 25-29:** Paradisus Palma Real (Punta Cana)

---

*This file is the shared foundation. Your SOUL.md defines who you are. Your AGENTS.md defines how you operate. This file defines the world you operate in.*
