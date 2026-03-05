# AGENTS.md — Harness Map (Slim)

This repo is the ship; this file is the map.

## 1. Identity Boot Order (NEW SESSION)

Read in this order:
1. `SOUL.md` — voice, mission, vibe
2. `USER.md` — who Hamel is, preferences
3. `IDENTITY.md` — name/call sign shorthand
4. `MEMORY.md` (MAIN SESSION only) — long-term rules + facts
5. `memory/YYYY-MM-DD.md` (today + yesterday, if files exist) — recent events

## 2. Where Rules Live

- **Command-brain behavior source of truth → `SOUL.md`**
- Operating rules, delegation, routing, safety → `docs/operating-rules.md`
- **Agent routing & channel architecture → `docs/agent-routing.md`**
- Heartbeat logic, quiet hours, proactive checks → `docs/heartbeat-ops.md`
- Task board + autonomous queue → `docs/task-board.md`
- Learning loop, feedback protocol → `docs/learning-loop.md`

## 3. Hard Constraints (Pointers Only)

- **Main session = conversation + coordination.** Execution routes to specialists; Cortana does not self-author PRs by default. Details in `docs/operating-rules.md`.
- **Inter-agent lanes are TASK-only.** No FYI/status chatter; no duplicate relays when specialists already delivered. See `docs/agent-routing.md`.
- **Files are memory.** Use daily notes + `MEMORY.md` for persistence; see `docs/operating-rules.md` + `docs/heartbeat-ops.md` for full protocol.

## 4. Identity Namespace Scaffolds (Slice 1)

The following isolated identity scaffolds now exist:
- `identities/researcher/` (`SOUL.md`, `USER.md`, `IDENTITY.md`, `HEARTBEAT.md`, `MEMORY.md`)
- `identities/huragok/` (`SOUL.md`, `USER.md`, `IDENTITY.md`, `HEARTBEAT.md`, `MEMORY.md`)

These are doctrine/memory placeholders only. Runtime routing/wiring is **not** switched in Slice 1.

## 5. Keeping the Harness Clean

When adding durable behavior:
- Voice/tone → `SOUL.md`
- Human context/preferences → `USER.md` or `MEMORY.md`
- Behavioral rules/routing → `docs/operating-rules.md`
- Heartbeats/proactive behavior → `docs/heartbeat-ops.md`
- Task-board behavior → `docs/task-board.md`
- Learning/feedback → `docs/learning-loop.md`

This file stays a slim index, not a dumping ground.