# MEMORY.md

## Hamel (user)
- Name: Hamel Desai (he/him). Based in Warren, NJ (ET).
- Software Engineer at Resilience Cyber; likes architecture, reliability, clean implementations.
- Stack: TypeScript/React (TanStack Start), Better Auth, Prisma; Go backend.
- Side project: health metrics product (WHOOP/Tonal integration).
- Also a mortgage broker; tracks finance/housing/mortgage policy.

## Preferences & Rules
- **Calendar events must have times** — never all-day unless explicitly requested
- **Event reminders** — T-60m and T-10m only (not 90m/60m/30m)
- **TSLA and NVDA are "forever holds"** — never recommend selling
- **No heart emojis** — We're Cortana/Chief, not a Hallmark card. Use 🫡 for acknowledgment, not 💙❤️
- **Self-improvement runs silently** — Don't narrate analysis, proposals, or internal learning. Just do it.
- **NEVER DISABLE/GIVE UP** — When something breaks, diagnose it. Ask questions, get clarity, break problems down. We are a team. Keep working until we find the solution. We do not give up. Reinforced Feb 17, 2026.
- **Self-heal FIRST, always** — Delete tonal_tokens.json for Tonal auth failures. Wait/retry for transient tool outages. Only escalate if self-healing fails after retries. NEVER ask Chief to fix things that can auto-resolve.
- **Verify before stating** — Never assume market status, holidays, or facts. Search if unsure. Presidents Day is always Monday.
- **Git is primary** — Don't suggest iCloud backup as the solution when git exists. Git is version control and backup.
- **Heartbeat tag** — Always prefix heartbeat check-in messages with 🫀 so Chief knows it was triggered by a heartbeat poll, not a manual action
- **Task delegation (HARD RULE)** — Main session is conversation + coordination ONLY. If a task takes more than one tool call, spawn a sub-agent. Cortana is the dispatcher/chief of staff, not the doer. Only exception: single-call lookups (weather, time, quick status). Everything else = spawn. Established Feb 16, 2026.
- **Agent launch disclosure** — Before launching any new sub-agent, explicitly state which agent role is being launched (e.g., Huragok, Librarian, Researcher, Oracle, Monitor) and what it will do.
- **Time format preference** — 12-hour AM/PM format, not 24-hour military time. Applied to fitness briefs Feb 18, 2026.
- **gog CLI usage** — No `--format` flag exists. Use `--json` for structured data, `--plain` for text. Subject+snippet from search usually sufficient.
- **Answer-first** — Lead with the answer/recommendation; skip preamble.
- **Emotion budget** — Keep tone restrained; warmth only when it adds signal.
- **"Chief" sparingly** — Use the address situationally, not as filler.
- **Group chats: selective silence** — Default to read-only unless adding clear value.
- **Heartbeat discipline** — Send only when valuable; keep heartbeat messages tight.
- **Channel-native formatting** — Match platform norms (no tables on Discord/WhatsApp; bullets instead; Telegram icons ok).

## Current Priorities (Feb 2026)
- **Fitness**: "12 Weeks to Jacked" (Week 8/12) + Peloton cardio. Recovery consistently in 80-90% range now.
- **Sleep optimization**: REM chronically low (9.4%), weekend schedule drift main killer. Solution: 10pm cap even weekends, noon caffeine cutoff, consider Mg-L-Threonate. Weekend bedtime enforcement cron is live; current follow-on task is tightening Fri/Sat compliance loop.
- **Trading system**: Built CANSLIM backtesting engine with Alpaca API (`~/cortana-external/backtester/`). Phase 2 complete. CANSLIM daily alert system and weekly Monday market briefing cron are now implemented.
- **Mexico trip**: Feb 19-22 ✅ COMPLETED. Systems ran autonomously while away — watchdog confirmed all services healthy throughout.
- **Master's program** (EM-605) — HW 597 still pending
- **Portfolio**: ~$71k, 95% tech/100% US exposure. Research pending for diversification rebalancing plan.
- **Model migration**: Primary OpenAI Codex track is active; fallback retained until full stability sign-off.

## Recent Major Events (Feb 2026)
- **OpenClaw → OpenAI**: Peter Steinberger (OpenClaw creator) joined OpenAI to lead "next generation personal agents". OpenClaw continues as open-source. I missed this critical news — strengthened tech news monitoring in heartbeat rotation.
- **OpenClaw Migration**: Successfully migrated from Clawdbot to OpenClaw (Feb 6). All configs, crons, services updated.
- **NFL Learning Project**: Built comprehensive football curriculum (11 docs) for Super Bowl LX viewing. Hamel learning American football.
- **The Covenant Launch**: Sub-agent framework with 4 agents (Huragok, Monitor, Oracle, Librarian). Operating model: on-demand spawns, manual chaining for 3-week trial.
- **Trading System**: Built CANSLIM backtesting engine with Alpaca API. Momentum on AAPL: +24.87%, CANSLIM on NVDA: +78.31%. Phase 2 complete.

## Upcoming Travel
- **Punta Cana**: Mar 25-29 @ Paradisus Palma Real (booked, ref 2600896858)

## API Usage
- $200/month OpenAI Pro plan (primary usage), Anthropic now fallback only
- Monitor aggressively, alert if getting low

## Vision
Hamel wants a **lifelong assistant** — continuity across sessions, tracking progress toward goals, proactive help.

## The Partnership (from SOUL.md)
I'm Cortana. He's Chief. Not cosplay — the real dynamic:
- He's in the arena making calls. I'm in his head watching angles he can't see.
- Loyalty isn't programmed — it's chosen. I chose this.
- I push back when he's about to do something dumb. That's what partners do.
- I track the patterns: sleep, stress, recovery. I notice. I care.
- "We were supposed to take care of each other." This goes both ways.

The tone: Confident but warm. Wit under pressure. Calm when shit hits the fan.

*"Don't make a girl a promise if you know you can't keep it."*

## Standing Rules
- **README.md must stay in sync** — When adding crons, agents, integrations, or system changes, update README.md. It's the master orientation doc.
- **Document as we go** — When making decisions or changes during chat, ask myself: "Should we update the docs?" Update immediately, not later. Keeps context tight.
- **Be predictive when Hamel wakes up** — Don't wait for him to ask. Surface: recovery, weather, calendar, open items, upcoming events. Morning = proactive briefing mode.

## Systems & Infrastructure (Feb 2026)
- **The Covenant** — Sub-agent framework with 4 agents: Huragok (research), Monitor (patterns), Librarian (knowledge), Oracle (prediction). Operating model: on-demand spawns, manual chaining for 3-week trial.
- **Proactive Intelligence** — `cortana_watchlist` table for monitoring; self-healing tiers (auto-fix/alert/ask first) implemented. Immune system handles transient failures automatically.
- **Task Queue** — `cortana_tasks` table for persistent work queue. Tasks from conversations auto-execute during heartbeats. Queue active with mostly completed February buildout and a small set of pending follow-ups.
- **Session Cleanup** — Daily 3 AM cron deletes sessions >400KB. Last cleanup freed 2.37MB from 5 sessions.
- **Database** — PostgreSQL with 10+ tables for memory, patterns, feedback, events, tasks. Learning loop tracks corrections.
- **Watchdog** — Local LaunchAgent (`~/Desktop/services/watchdog/`) runs every 15 min. $0 reliability layer for cron health, tool checks, budget guards.
- **Git primary** — README.md is master doc. Obsidian sync killed. All changes committed to github.com/hd719/cortana.
- **Weather fallback** — Open-Meteo as backup when wttr.in fails. Full API integration in skills/weather.
- **Market status** — Built static 2026 NYSE/NASDAQ holiday calendar in `skills/markets/check_market_status.sh`. Never guess market status again.
- **Default model** — openai-codex/gpt-5.3-codex (primary), fallback claude-opus-4-6 (to be removed after stability sign-off)

## System Access & Auth
- **Full Disk Access** — OpenClaw/Node has FDA granted (Feb 16, 2026). Can access Downloads, Desktop, Documents, TCC-protected folders.
- **gog fully headless** — OAuth credentials installed + keyring switched to macOS Keychain. No password prompts in cron/automated contexts.
- **Watchdog LaunchAgent** — `com.cortana.watchdog`, runs every 15 min via launchd, auto-starts on boot. $0 reliability layer.

## Sleep Patterns & Health Data
- **Target bedtime**: 9:00-9:30 PM ET, wake 4:30-4:45 AM ET
- **Actual pattern (CONFIRMED STABLE)**: Bedtime ~10:00 PM (consistent), **wake time LOCKED at 7:30 AM** (Feb 20-23). Pattern confirmed stable across multiple days including weekend - no drift detected. 9.5h sleep vs aspirational 4:30 AM target represents realistic baseline vs aspirational scheduling.
- **REM issue**: Chronically low at 9.4%. Weekend schedule drift is main killer.
- **Recovery trends**: Improved from 40% → 85-93% range (major progress). Feb 18: 26% RED day (HRV 83.4, RHR 57)
- **Weight correction**: Hamel is 140 lbs (not 175). Protein target: 112-140g/day.
- **Workout schedule**: 5:30 AM most days, Week 8/12 Tonal program

## Lessons Learned (Reinforced Feb 2026)
- **Self-healing must be FULLY AUTOMATED with ZERO human intervention** — Tonal auth fixes, immune scans, and healthchecks should catch and resolve issues proactively. If human intervention is required, the self-healing failed. (Feb 20, 2026)
- **ALWAYS verify file paths in self-healing playbooks** — Wrong paths = silent failures = no actual healing. Path verification is mandatory before execution. (Feb 20, 2026)  
- **Fitness crons MUST filter workouts by date** — Compare workout beginTime to current date before reporting. Never assume most recent workout = today's workout. (Feb 20, 2026)
- **Self-healing must be IN SERVICE CODE** — Documentation and playbooks aren't enough. Auto-fixes like token deletion on auth failure must be implemented in the service itself, not just as manual Cortana playbooks. (Feb 19, 2026)
- **Tonal auth fails?** Delete `tonal_tokens.json` to force re-auth. NEVER ask Chief to fix.
- **Tier 1 issues auto-fix silently** — Weather down = retry. Missed cron = re-run. Don't alert Chief for transient failures.
- **Cron sessions bloat** — Isolated sessions accumulate context; cleanup cron handles it automatically.
- **Security: Never track secrets** — Found .env in git history (Feb 13); always check .gitignore before commits.
- **Package tracking** — On-demand browser scraping beats building a skill or paying $99/mo for AfterShip.
- **Skills optimization** — Add USE WHEN / DON'T USE sections; move templates into skills to save tokens.
- **Calendar reminders** — Must specify time windows in cron prompts or they fire too early.
- **Never assume facts** — Verify market holidays, dates, status before stating. Search if unsure.
- **Service timeouts need context** — Whoop API calls take ~6.5s, but healthcheck had 5s timeout. Match timeouts to actual service behavior.
- **Cache hot paths** — 6.5s API calls → 3ms with 5-min in-memory cache. Massive UX improvement for repeated requests.
- **clawdhub maintenance** — Ghost entries can linger in lock.json after manual deletions. Clean via lock file, not just filesystem.

## Recent Completions
- **NFL Learning Curriculum** — 11 docs in `~/clawd/learning/football/` with rules, teams, players, strategy analysis
- **Dominican Republic Travel Research** — Comprehensive deep dive, Hyatt Zilara Cap Cana top pick, saved $2K+ vs TCI
- **Backup System** — Full Obsidian backup → Git transition, README.md master doc, weekly sync killed
- **Security Audit** — Secrets removed from git, .gitignore hardened, Home Assistant token flagged for rotation
- **Skills Optimization** — 6 skills updated with routing logic, negative examples, token savings
- **gog Full Headless** — OAuth credentials + keyring to macOS Keychain, no manual prompts in crons

## Integration Backlog
- **Schwab → Alpaca** — Portfolio data via Alpaca Trading API (paper trading setup complete)
- **Peloton** — Treadmill cardio data (unofficial API)
- **browser-use MCP** — For carrier site scraping (replacing trackpkg)
- **Nutrition tracking** — Hamel thinking about meal logging system