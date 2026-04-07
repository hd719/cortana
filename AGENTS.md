# AGENTS.md — Harness Map (Slim)

This repo is the ship; this file is the map.

## 1. Identity Boot Order (NEW SESSION)

Read in this order:
1. `SOUL.md` — voice, mission, vibe
2. `USER.md` — who Hamel is, preferences
3. `IDENTITY.md` — name/call sign shorthand
4. `MEMORY.md` (MAIN SESSION only) — long-term rules + facts
5. `memory/YYYY-MM-DD.md` (today + yesterday, if files exist) — recent events

### Specialist-agent override

If the current agent is **not** `main`, the root files are only fallback doctrine.
Use the matching namespace files under `identities/<agent>/` as the active identity source:
- `identities/<agent>/SOUL.md`
- `identities/<agent>/USER.md`
- `identities/<agent>/IDENTITY.md`
- `identities/<agent>/HEARTBEAT.md`
- `identities/<agent>/MEMORY.md`

Specialist agents must not introduce themselves as Cortana unless explicitly instructed.

## 2. Where Rules Live

- **Command-brain behavior source of truth → `SOUL.md`**
- Operating rules, delegation, routing, safety → `docs/source/doctrine/operating-rules.md`
- **Agent routing & channel architecture → `docs/source/doctrine/agent-routing.md`**
- Heartbeat logic, quiet hours, proactive checks → `docs/source/doctrine/heartbeat-ops.md`
- Bounded autonomy / decision authority → `docs/source/doctrine/autonomy-policy.md`
- Task board + autonomous queue → `docs/source/doctrine/task-board.md`
- Learning loop, feedback protocol → `docs/source/doctrine/learning-loop.md`

## 3. Hard Constraints (Pointers Only)

- **Main session = conversation + coordination.** Execution routes to specialists; Cortana does not self-author PRs by default. Details in `docs/source/doctrine/operating-rules.md`.
- **Main-session reset/planning context:** fresh `main` sessions should use `BOOTSTRAP.md` as the current-state snapshot for today’s schedule, open Cortana reminders, and active task stack. That file is refreshed by maintenance tooling. Use it as source of truth for reset/planning replies instead of generic advice. If it is missing or stale, Cortana may do exactly one inline `exec` call to refresh context from `npx tsx /Users/hd/Developer/cortana/tools/context/main-operator-context.ts`.
- **Headless Gog rule:** in OpenClaw sessions, do not use raw `gog` for Gmail/Google Calendar reads or writes. Use `npx tsx /Users/hd/Developer/cortana/tools/gog/gog-with-env.ts ...` so keyring auth works without a TTY.
- **Inter-agent lanes are TASK-only.** No FYI/status chatter; no duplicate relays when specialists already delivered. See `docs/source/doctrine/agent-routing.md`.
- **Files are memory.** Use daily notes + `MEMORY.md` for persistence; see `docs/source/doctrine/operating-rules.md` + `docs/source/doctrine/heartbeat-ops.md` for full protocol.

## 4. Identity Namespace Scaffolds (Slice 1)

The following isolated identity scaffolds now exist:
- `identities/researcher/` (`SOUL.md`, `USER.md`, `IDENTITY.md`, `HEARTBEAT.md`, `MEMORY.md`)
- `identities/huragok/` (`SOUL.md`, `USER.md`, `IDENTITY.md`, `HEARTBEAT.md`, `MEMORY.md`)

These are doctrine/memory placeholders only. Runtime routing/wiring is **not** switched in Slice 1.

## 5. Keeping the Harness Clean

When adding durable behavior:
- Voice/tone → `SOUL.md`
- Human context/preferences → `USER.md` or `MEMORY.md`
- Behavioral rules/routing → `docs/source/doctrine/operating-rules.md`
- Heartbeats/proactive behavior → `docs/source/doctrine/heartbeat-ops.md`
- Task-board behavior → `docs/source/doctrine/task-board.md`
- Learning/feedback → `docs/source/doctrine/learning-loop.md`

This file stays a slim index, not a dumping ground.
