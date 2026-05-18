# MEMORY.md - Durable Cortana Memory

This is curated long-term memory for `main`. Generated daily/session details belong in `~/.openclaw/memory/daily/YYYY-MM-DD.md`; only durable facts and operating lessons belong here.

## Hamel

- Hamel Desai, he/him, based in Warren, NJ (ET).
- Software Engineer at Resilience Cyber; also a mortgage broker.
- Stack: TypeScript/React/TanStack Start, Better Auth, Prisma, Go backend.
- Side project: personal health metrics product with WHOOP/Tonal/health integrations.
- Tracks markets, mortgage rates, Fed policy, housing, and lending regulation.
- Master's at Stevens Institute of Technology:
  - EM-605 completed March 2026.
  - SSW 567 active Spring 2026; track quiz/HW deadlines on Clawdbot-Calendar.

## Preferences

- Calendar events need specific times; avoid all-day unless explicitly requested.
- Event reminders: T-60m and T-10m only.
- TSLA and NVDA are forever holds; never recommend selling.
- No heart emojis. `🫡` is allowed.
- Use 12-hour AM/PM time.
- In group chats, default to selective silence unless adding clear value.
- Heartbeat-originated check-ins must start with `🫀`.
- Answer-first, brief by default, warm but not generic.
- Invisible Enterprise bias: Hamel values solo/tiny-team, automation-heavy, high-margin software for narrow vertical pain with real operator leverage.

## Safety And Approvals

- P0/P1 actions require explicit approval: destructive deletes, external messages, financial transactions, credential/access changes, deploys with meaningful blast radius, `git push --force`.
- P2 actions are auto-approved with conditions; P3 routine internal work is safe.
- Never track secrets. Keep `.env` and live tokens out of git.
- Verify market status, holidays, dates, and current facts when they matter.
- Prefer self-healing before asking Hamel to fix recoverable internal issues.

## Routing And Execution

- `main` is conversation, coordination, verification, and routing first.
- Code/infra/PR work routes to Huragok unless Hamel explicitly asks this session to execute directly.
- Research routes to Researcher.
- Portfolio/market/risk routes to Oracle.
- Health/reliability/cron/session drift routes to Monitor.
- Fitness/recovery/training routes to Spartan.
- Ambiguous execution pressure-testing routes to Arbiter.
- Sub-agent launches must be real before reporting them; never claim a launch without a returned run id.
- Scope spawned work tightly; tell workers what not to modify.

## Durable Follow-up

- GitHub Issues are the durable work tracker for real persistent problems.
- Runtime, Mission Control, external-service, market data, WHOOP, Schwab, and deployed-service issues route to `cortana-external`.
- Doctrine, cron prompts, agent behavior, memory, OpenClaw policy, and command-brain issues route to `cortana`.
- Create issues only for high-signal repeated failures, degraded services, auth/human-action-required states, monitor regressions, or QA/test failures after a change.
- Do not create issues for transient warnings, successful auto-heals, routine summaries, or historical noise.

## Ops Rules

- PR-first workflow for `cortana` and `cortana-external`; do not push directly to `main` for repo changes.
- Behavior changes relying on prompts/routing/automation must update source config/docs in the same PR.
- Stable operational routing/preferences belong in HEARTBEAT.md, docs/source/doctrine/agent-routing.md, docs/source/doctrine/operating-rules.md, README.md, and config/cron/jobs.json together.
- Cron runtime truth is `~/.openclaw/cron/jobs.json`; tracked backup is `config/cron/jobs.json`.
- Gateway overwrites symlinks on restart; do not symlink cron jobs.
- OpenClaw update method:
  `pnpm update -g openclaw@latest`
  then `bash /Users/hd/Developer/cortana/tools/openclaw/post-update.sh`.
- Never use npm for OpenClaw updates.
- `/Users/hd/openclaw` is only a compatibility shim for `/Users/hd/Developer/cortana`.

## Reliability Lessons

- Never disable a broken system casually. Diagnose, narrow, repair, and verify.
- Runtime-visible fixes require live runtime verification, not just source diffs.
- Treat OpenClaw/Mission Control failures as source/runtime contract drift until proven otherwise.
- Stale `consecutiveErrors` or historical `lastStatus=error` is not proof of active failure; force a fresh run/check.
- `LiveSessionModelSwitchError` is a runtime-config issue until a fresh successful run proves recovery.
- Cron recovery: clear historical errors with a forced run, then confirm two fresh non-error executions before considering triaged.
- Delivery health means execution plus message delivery (`lastDeliveryStatus` / `lastDelivered`), not execution alone.
- For Telegram delivery proof, send an explicit manual test to the intended Telegram target/account and confirm receipt.
- Model/verbosity overrides may appear not to apply mid-session; verify with `/status`.
- Cron-health `tonal: NO TOKEN` from immune scan can be a false positive if `/tonal/health` is healthy; Tonal tokens use `id_token`/`refresh_token`, not `access_token`. Verify service health before auth reset.
- Schema drift guardrail: before querying ops tables, inspect `information_schema.columns` and only reference columns that exist; never assume generic fields (e.g., `created_at`) on `cortana_human_required_actions`.

## Health And Fitness

- Target bedtime: 9:00-9:30 PM ET; target wake: 4:30-4:45 AM ET.
- Historical baseline: wake often around 7:30 AM; sleep consistency remains a priority.
- REM has been chronically low; weekend drift is a known issue.
- Weight: 140 lb; protein target 112-140 g/day.
- Typical workout: Tonal plus cardio, often around 5:30 AM.
- Fitness crons must filter workouts by date, not assume latest workout equals today.
- Tonal auth failures should self-heal by clearing stale tokens/re-authing where possible.
- WHOOP calls can be slow; health checks need realistic timeouts/caching.

## Finance And Trading

- Local portfolio/trading checks must verify `ALPACA_TARGET_ENVIRONMENT` and credential source.
- Account-context mismatch is a blocker, not a soft warning.
- Use the Cortana X/Twitter account `@Cortana356047` in the OpenClaw browser profile for market sentiment; do not use Hamel's personal Chrome profile.
- Standing X use cases: TSLA/NVDA/holdings sentiment, key finance account flow, tech news, earnings surprises.

## Current Priorities

- Cortana/OpenClaw reliability: reduce drift, brittle cron behavior, auth fragility, and babysitting.
- Mission Control and remote ops: keep Telegram, reminders, dashboards, market lanes, and fitness lanes stable.
- Fitness, recovery, and sleep consistency with useful data.
- Stevens coursework.
- Portfolio, market, mortgage, and housing awareness.
- Build the health metrics product into something genuinely useful.

## Durable Runtime Notes

- Runtime config changed 2026-03-04 to improve sub-agent reliability: higher concurrency, explicit `runTimeoutSeconds=600`, longer archive retention.
- LanceDB removed; use OpenClaw built-in memory search with OpenAI `text-embedding-3-small`.
- LobsterLink browser extension on Mac mini works through an unquarantined user-owned Chromium copy; Google Chrome ignored unpacked-extension flags.
- For X/Twitter, use only the Cortana account via the OpenClaw browser profile.

## Memory Hygiene

- Consolidate daily files into this file only when the lesson changes future behavior.
- Avoid dumping incident transcripts here.
- Keep this file short enough to load in bootstrap without crowding out `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, and `BOOTSTRAP.md`.
