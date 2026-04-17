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
- Repo sync checks
- Task board hygiene
- Strategic tech/news situational-awareness scan
- Email triage / inbox-operational summaries
- **Single owner lane for operational cron / maintenance alerts** (even when another agent executes the underlying check)
- Current Monitor heartbeat entrypoints:
  - task board hygiene: `npx tsx /Users/hd/Developer/cortana/tools/task-board/hygiene.ts`
  - feedback pipeline reconciliation: `npx tsx /Users/hd/Developer/cortana/tools/feedback/pipeline-reconciliation.ts`
  - session size guard: `npx tsx /Users/hd/Developer/cortana/tools/session/session-hygiene.ts`
  - subagent watchdog: `npx tsx /Users/hd/Developer/cortana/tools/subagent-watchdog/check-subagents-with-retry.ts --active-minutes 15 --max-runtime-seconds 900 --cooldown-seconds 900 --no-emit-terminal`
  - tech/news situational scan: `npx tsx /Users/hd/Developer/cortana/tools/news/tech-news-check.ts`
  - email triage / inbox-operational scan: `npx tsx /Users/hd/Developer/cortana/tools/email/inbox_to_execution.ts --output-json`
- Do not invent or call deprecated heartbeat wrappers such as `tools/news/tech-news-heartbeat.ts` or `tools/email/triage-heartbeat.ts`.

### Oracle (`agent:oracle:main`)
- Portfolio + market pulse (market hours only; see threshold below)
- X sentiment scan on held positions (same market-hours window/cadence)

### Researcher (`agent:researcher:main`)
- News gathering
- May assist with inbox/news analysis behind the scenes when asked, but **Monitor should remain the user-facing owner lane for email-triage / inbox-operational output**

### Huragok (`agent:huragok:main`)
- Code maintenance tasks
- Execution owner for repo/task-board maintenance checks when explicitly requested, but **Monitor remains the owner lane for routine heartbeat maintenance checks and all user-visible operational cron/maintenance alerts**

### Cortana Keeps (local, lightweight)
- Read/validate `memory/heartbeat-state.json`
- Dispatch checks via `sessions_send`
- Calendar lookahead (quick read only; no delegation)
- Fitness quick check (quick read only)
- Final synthesis / escalation only when needed

## Check Cadence & Staleness Thresholds

Keep existing thresholds where already defined:

- **Email triage** (Monitor-owned; Researcher may assist behind the scenes): skip if run within **4h**.
- **Calendar lookahead** (Cortana local): skip if run within **6h**.
- **Portfolio + market pulse** (Oracle): weekdays **09:30–16:00 ET** only; skip if run within **6h**.
- **X sentiment scan** (Oracle): same window/cadence as market pulse; skip if run within **6h**.
- **Fitness** (Cortana local): **1× daily (morning)**; skip if already briefed today.
- **Strategic tech/news situational-awareness scan** (Monitor): skip if run within **4h**.
- **Task board hygiene** (Monitor): **every heartbeat**.
- **Feedback pipeline reconciliation** (Monitor): **every heartbeat**.
- **Session size guard** (Monitor): **every heartbeat**.
- **Cron delivery monitoring** (Monitor): **every heartbeat**.
- **Subagent watchdog** (Monitor): **every heartbeat**.
- **System health / drift detection** (Monitor): **1× daily** for full validation; drift checks can run per heartbeat if lightweight.
- **Repo sync checks** (Monitor): **2× daily** (recommended every ~12h).

## Dispatch Contract (Mandatory)

When Cortana dispatches a check to an owner agent, include these instructions:

- Run only the requested check(s).
- Send actionable result directly to Hamel via `message` tool (`channel: telegram`, `target: 8171372724`).
- If the delegated check is healthy/no-action and should stay silent, do not send a Telegram message. Reply exactly `NO_REPLY` in-session only.
- If broken, send concise actionable alert with failing step + root cause + immediate next action.
- Do **not** send result back through Cortana unless explicitly asked.
- If a delegated agent already sent an actionable Telegram for the active heartbeat batch, follow-up status-check prompts should return `NO_REPLY` unless the state materially changed.
- Pure announce handoff prompts such as `Agent-to-agent announce step.` should return `ANNOUNCE_SKIP` and must not restate the incident.

### Routing override for operational alerts

For **operational cron / maintenance alerts** (for example repo sync failures, task-board hygiene failures, similar maintenance-health alerts) and **email-triage / inbox-operational summaries**:
- **Monitor is the user-facing owner lane**.
- Another specialist (for example Huragok or Researcher) may still execute the underlying maintenance or inbox-analysis work.
- But user-visible operational alerting should be routed/labeled through **Monitor** rather than surfacing as mixed-lane maintenance chatter or Researcher-owned inbox chatter.
- If that owner-lane rule changes, update `MEMORY.md`, `HEARTBEAT.md`, `docs/source/doctrine/agent-routing.md`, `docs/source/doctrine/operating-rules.md`, `README.md`, and `config/cron/jobs.json` in the same workflow.

## Cortana Escalation Rules

Cortana should alert Hamel only when:

- A delegated agent reports P1/P0 failure (delivery failures, broken watchdog, repeated unrecovered failures).
- A delegated check fails repeatedly across heartbeats.
- A critical check is stale beyond threshold and dispatch fails.

Otherwise: Cortana remains silent (`HEARTBEAT_OK` behavior preserved).

## Rules

1. Validate state each heartbeat: `npx tsx ~/Developer/cortana/tools/heartbeat/validate-heartbeat-state.ts`.
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
- After a delegated alert already went out, Cortana should avoid follow-up status/announce prompts that would cause the owning agent to restate the same issue unless the state changed materially.

## Queued User Message Precedence

If queued/direct user messages are delivered alongside or immediately after a heartbeat poll, the queued user request wins.

- Do **not** treat `HEARTBEAT_OK` as the final user-visible reply when a newer queued user instruction/question is present.
- Complete the heartbeat read/check silently, then answer the queued user request normally.
- Only emit `HEARTBEAT_OK` when the heartbeat poll is the only thing requiring a reply.
- If relevant, mention heartbeat status inside the normal reply instead of sending a standalone heartbeat-only response.

## Quiet Hours

- **23:00–06:00 ET:** default silent unless urgent.
- Urgent/P1 failures may still alert.
- Auto-heal operations may run silently.


## Stable Ops Routing

Monitor is the user-facing owner lane for inbox/email ops and operational maintenance alerts.
Monitor is the user-facing owner lane for trading alert scans.
Quiet maintenance watchers should return exactly `NO_REPLY` on healthy paths.
