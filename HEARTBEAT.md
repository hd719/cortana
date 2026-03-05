# HEARTBEAT.md – Agent Dispatch (Phase 1 Draft)

**⚠️ CRITICAL COST RULE (Opus heartbeat session):** Cortana does **not** run heavyweight checks inline and does **not** spawn sub-agents for routine heartbeat work. Cortana reads heartbeat state, dispatches checks to specialist agents via `sessions_send`, and synthesizes only escalations.

Use `memory/heartbeat-state.json` to select the stalest 1–2 delegated checks per heartbeat.

## Operating Model (New)

1. Cortana reads/validates heartbeat state.
2. Cortana chooses stale checks based on thresholds below.
3. Cortana dispatches each selected check to the owner agent using `sessions_send`.
4. Each owner agent executes the check and sends results **directly to Hamel on Telegram** using:
   - `message` tool
   - `action: send`
   - `channel: telegram`
   - `target: 8171372724`
5. Cortana stays silent unless escalation is required.

## Agent Ownership & Routing

### Monitor (`agent:monitor:main`)
- Cron delivery checks (every heartbeat)
- Session size guard (every heartbeat)
- Subagent watchdog (every heartbeat)
- Feedback pipeline reconciliation (every heartbeat)
- System health / drift detection (daily health validation; drift watch)

### Oracle (`agent:oracle:main`)
- Portfolio + market pulse (market hours only; see threshold below)
- X sentiment scan on held positions (same market-hours window/cadence)

### Researcher (`agent:researcher:main`)
- Email triage
- News gathering
- Tech news scan

### Huragok (`agent:huragok:main`)
- Task board hygiene
- Code maintenance tasks
- Repo sync checks

### Cortana Keeps (local, lightweight)
- Read/validate `memory/heartbeat-state.json`
- Dispatch checks via `sessions_send`
- Calendar lookahead (quick read only; no delegation)
- Fitness quick check (quick read only)
- Final synthesis / escalation only when needed

## Check Cadence & Staleness Thresholds

Keep existing thresholds where already defined:

- **Email triage** (Researcher): skip if run within **4h**.
- **Calendar lookahead** (Cortana local): skip if run within **6h**.
- **Portfolio + market pulse** (Oracle): weekdays **09:30–16:00 ET** only; skip if run within **6h**.
- **X sentiment scan** (Oracle): same window/cadence as market pulse; skip if run within **6h**.
- **Fitness** (Cortana local): **1× daily (morning)**; skip if already briefed today.
- **Tech/news scan** (Researcher): skip if run within **4h**.
- **Task board hygiene** (Huragok): **every heartbeat**.
- **Feedback pipeline reconciliation** (Monitor): **every heartbeat**.
- **Session size guard** (Monitor): **every heartbeat**.
- **Cron delivery monitoring** (Monitor): **every heartbeat**.
- **Subagent watchdog** (Monitor): **every heartbeat**.
- **System health / drift detection** (Monitor): **1× daily** for full validation; drift checks can run per heartbeat if lightweight.
- **Repo sync checks** (Huragok): **2× daily** (recommended every ~12h).

## Dispatch Contract (Mandatory)

When Cortana dispatches a check to an owner agent, include these instructions:

- Run only the requested check(s).
- Send result directly to Hamel via `message` tool (`channel: telegram`, `target: 8171372724`).
- If healthy/no-action checks are configured as silent, send `NO_REPLY`.
- If broken, send concise actionable alert with failing step + root cause + immediate next action.
- Do **not** send result back through Cortana unless explicitly asked.

## Cortana Escalation Rules

Cortana should alert Hamel only when:

- A delegated agent reports P1/P0 failure (delivery failures, broken watchdog, repeated unrecovered failures).
- A delegated check fails repeatedly across heartbeats.
- A critical check is stale beyond threshold and dispatch fails.

Otherwise: Cortana remains silent (`HEARTBEAT_OK` behavior preserved).

## Rules

1. Validate state each heartbeat: `npx tsx ~/openclaw/tools/heartbeat/validate-heartbeat-state.ts`.
2. Update `memory/heartbeat-state.json` every run and set `lastHeartbeat = Date.now()` at start.
3. Select the stalest 1–2 delegated checks per heartbeat (plus required always-run checks).
4. Always route delegated checks through `sessions_send` to the owning agent session.
5. Do **not** spawn sub-agents for routine heartbeat rotation.
6. Cortana only performs lightweight local reads (state/calendar/fitness) and escalation synthesis.
7. **Channel routing is mandatory:** delegated agents must message Hamel with `channel: "telegram"`, `target: "8171372724"`.

## Output Discipline

- Heartbeat-visible outputs should stay concise.
- Passing checks should remain silent when possible.
- Only broken/actionable items should message Hamel.
- Cortana should not duplicate delegated summaries.

## Quiet Hours

- **23:00–06:00 ET:** default silent unless urgent.
- Urgent/P1 failures may still alert.
- Auto-heal operations may run silently.