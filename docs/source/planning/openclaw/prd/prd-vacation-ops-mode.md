# Product Requirements Document (PRD) - Vacation Ops Mode and Readiness System

**Document Status:** Draft v1

## Team

| Role | Assignee |
|------|----------|
| Primary Owner | Hamel |
| Epic | Vacation Ops Mode and Readiness System |

---

## Problem / Opportunity

`cortana` currently operates a broad automation surface:

- OpenClaw gateway and agent runtime
- Telegram delivery across `main` and `monitor`
- Mission Control and other operator dashboards
- Google Calendar / Gmail access via `gog`
- Apple Reminders checks
- Morning Brief and other user-facing comms
- market, fitness, maintenance, and health cron lanes
- external services such as fitness service, Schwab market data, Mission Control, and backtester surfaces

The system already has many health checks, watchdogs, and cron-level probes, but it does not yet provide a single explicit operational model for extended unattended operation.

That creates a real reliability gap when Hamel is away from the Mac mini for multiple days or weeks.

Today, the system can tell Hamel that something is broken, but there is no single authoritative answer to the questions that matter before departure:

- Is the system truly ready for unattended operation for the next `30` days?
- Which failures are unacceptable vs tolerable?
- Which repairs are allowed automatically while Hamel is away?
- Which failures require human approval or interactive auth before departure?
- What exactly should the system continue doing in vacation mode?
- What compact operator summary should Hamel receive while away?

The opportunity is to formalize a deterministic, LLM-agnostic operating system for unattended periods.

That system should let Hamel trigger a pre-vacation audit, perform any required human-in-the-loop auth refreshes before leaving, certify go / no-go status, enter a bounded unattended mode, continue normal high-value automations, and receive compact daily summaries plus actionable alerts.

Explicit non-goals:

- This project is not intended to make every system component self-healing in open-ended ways.
- This project is not intended to remove the need for human approval on interactive reauth.
- This project is not intended to replace the existing monitors, probes, dashboards, or cron fleet; it must compose them into one operating model.

---

## Insights

Observed system state and constraints already point to the right architecture.

What exists today:

- `42` enabled cron jobs across `cron-comms`, `cron-maintenance`, `cron-health`, `cron-market`, and `cron-fitness`
- an existing baseline command in [`/Users/hd/Developer/cortana/tools/qa/green-baseline.sh`](/Users/hd/Developer/cortana/tools/qa/green-baseline.sh)
- runtime health checks such as [`/Users/hd/Developer/cortana/tools/openclaw/runtime-integrity-check.ts`](/Users/hd/Developer/cortana/tools/openclaw/runtime-integrity-check.ts)
- synthetic probes such as [`/Users/hd/Developer/cortana/tools/monitoring/critical-synthetic-probe.ts`](/Users/hd/Developer/cortana/tools/monitoring/critical-synthetic-probe.ts)
- a vacation guard in [`/Users/hd/Developer/cortana/tools/monitoring/vacation-mode-guard.ts`](/Users/hd/Developer/cortana/tools/monitoring/vacation-mode-guard.ts)
- existing bounded remediation patterns for gateway env drift, runtime sync drift, stale sessions, and service restart/reload flows

What is missing:

- a canonical vacation-specific tier model (`Tier 0`, `Tier 1`, `Tier 2`, `Tier 3`)
- a single authoritative `PASS / WARN / FAIL / NO-GO` readiness result
- a deterministic list of allowed automatic repairs while away
- a formal distinction between `pre-vacation prep` and `vacation mode`
- a compact daily vacation summary contract
- a unified incident ledger for vacation-window failures, repairs, and outcomes
- a calendar-aware recommendation for when Hamel should trigger prep before departure

Key design constraints:

- the system must remain LLM agnostic
- essential behavior must live in code, typed config, or explicit schemas, not only prompt text
- the system must continue producing normal user value while away, including market, fitness, and news outputs
- `Daily Auto-Update` should be disabled during vacation mode
- interactive reauth is allowed only before departure or later with Hamel’s explicit approval
- deeper agent investigation may be allowed, but only after an alert and within clearly defined boundaries

Problems this project is not intended to solve:

- making provider tokens immortal or bypassing external auth expiry indefinitely
- turning vacation mode into a full general-purpose autonomous debugging system
- replacing Mission Control, OpenClaw dashboards, or current monitoring tools with a new parallel UI

---

## Development Overview

This project should be built primarily in the `cortana` repo, with targeted checks into `cortana-external` where operator-facing services depend on it.

Primary repo:
- `cortana`

Secondary repo dependencies:
- `cortana-external` for Mission Control, backtester app, and external service readiness checks where those systems are part of vacation-critical health

Main implementation areas in `cortana` will likely include:

- a deterministic vacation readiness runner
- a deterministic vacation mode enable / disable mechanism
- a compact daily vacation summary generator
- a vacation incident ledger
- a remediation policy table that defines which automatic actions are permitted
- typed config describing the in-scope systems, required checks, and go / no-go logic
- canonical vacation state stored in Postgres, with any runtime file mirrors treated as non-canonical execution caches only

The system should explicitly support two phases:

1. `Pre-Vacation Prep`
- manually triggered by Hamel, or recommended by the system based on travel calendar context
- allowed to ask for human-approved interactive reauth or manual steps
- required to run real end-to-end Telegram test messages
- required to produce a deterministic readiness report and go / no-go result

2. `Vacation Mode`
- manually enabled after prep succeeds
- time-bounded with an explicit end date
- continues normal comms, market, fitness, and news operations
- disables `Daily Auto-Update`
- allows only deterministic bounded self-heal
- sends compact morning and evening summaries to `monitor`
- auto-disables on the configured end date and sends a `normal ops resumed` summary

What must be deterministic in code:

- system tier classification
- go / no-go rules
- allowed repair ladder
- vacation mode activation state and end date
- daily summary schema
- incident ledger schema
- exact list of Tier 0 / Tier 1 systems and their required smoke checks
- exact end-to-end Telegram test behavior
- explicit handling of interactive-auth-required failures

What may still use prompt behavior, but only on top of deterministic rules:

- phrasing of human-readable summaries
- compact wording of Telegram messages
- secondary explanation text for a failure that is already classified by code

What is intentionally deferred:

- major UI redesign of Mission Control
- provider-specific auth rearchitecture beyond the current deterministic repair envelope
- converting all current monitors into one monolithic check runner
- generalized autonomous code mutation during vacation mode

---

## Success Metrics

Success should be measured with explicit operational outcomes.

- `100%` of Tier 0 and Tier 1 checks must run from a single vacation readiness command.
- `100%` of Tier 0 and Tier 1 checks must produce machine-readable pass/fail results with timestamps and evidence.
- A pre-vacation run must return one of exactly four readiness outcomes: `PASS`, `WARN`, `FAIL`, `NO-GO`.
- Any Tier 0 failure must produce `NO-GO`.
- Any Tier 1 failure that remains unresolved after allowed remediation must produce `NO-GO`.
- Tier 2 failures may degrade readiness to `WARN`, but must not silently pass.
- Vacation mode must send morning and evening summaries to `monitor` on `100%` of healthy days, unless Telegram itself is degraded.
- Vacation-mode summaries must stay compact enough for mobile reading and fit within one short Telegram message.
- `100%` of automatic repair attempts during vacation mode must be logged with: incident, action taken, result, and verification outcome.
- `0` interactive reauth attempts may be performed autonomously while vacation mode is active.
- `100%` of vacation mode activations must auto-disable on the configured end date and emit one `normal ops resumed` message.

---

## Assumptions

- The Mac mini remains powered on, networked, and able to run OpenClaw continuously.
- Tailscale remains the expected remote-access path for Hamel while away.
- Telegram remains the primary operator alert and summary channel.
- Mission Control and OpenClaw dashboard availability matter because Hamel may rely on them remotely.
- Existing service auth can be refreshed the day before departure if required.
- The system can read Hamel’s travel plans from Google Calendar, but must not auto-enable vacation mode solely from that signal.
- Existing runtime integrity, synthetic probes, and cron/job telemetry remain available as inputs.
- Both `cortana` and `cortana-external` can be inspected by the system, but primary orchestration lives in `cortana`.
- `Daily Auto-Update` is safe to disable during vacation mode and safe to restore automatically afterward.

---

## Out of Scope

- automatic repo upgrades or package upgrades during vacation mode
- autonomous interactive auth flows without Hamel’s explicit approval
- open-ended self-directed code changes while unattended
- replacing the existing cron fleet with a new scheduler
- redesigning the business logic of Morning Brief, market scans, or fitness summaries beyond their vacation-operability requirements

---

## High Level Requirements

> **Note:** This project must remain LLM agnostic. Every critical requirement below must be satisfiable through deterministic code, typed config, explicit schemas, or documented runbook state.

| Requirement | Description | Notes |
|-------------|-------------|-------|
| [Requirement 1 - Readiness Audit](#requirement-1---readiness-audit) | Provide one authoritative pre-vacation readiness command with exact pass/fail logic. | Must support go / no-go. |
| [Requirement 2 - Pre-Vacation Prep Workflow](#requirement-2---pre-vacation-prep-workflow) | Support human-in-the-loop auth refresh, token verification, and real Telegram end-to-end testing before departure. | Manual trigger required. |
| [Requirement 3 - Vacation Mode State Machine](#requirement-3---vacation-mode-state-machine) | Introduce an explicit unattended mode with start/end dates, auto-disable, and safe policy changes. | Must disable `Daily Auto-Update`. |
| [Requirement 4 - Deterministic Remediation Policy](#requirement-4---deterministic-remediation-policy) | Define exactly which automatic repairs are allowed while away and how they are verified. | No interactive reauth while active. |
| [Requirement 5 - Vacation Summary and Alerting](#requirement-5---vacation-summary-and-alerting) | Send compact morning/evening summaries and actionable failure alerts to `monitor`. | Mobile-friendly. |
| [Requirement 6 - Vacation Incident Ledger](#requirement-6---vacation-incident-ledger) | Persist every failure, repair, and unresolved issue during the vacation window for later review. | Supports retrospective. |
| [Requirement 7 - System Scope and Tiering](#requirement-7---system-scope-and-tiering) | Explicitly classify in-scope systems into operational tiers with clear readiness consequences. | Prevents vague “everything is broken” status. |

---

## Detailed User Stories

State how the completed system should behave and where users or operators will interact with it.

### Glossary

| Term | Meaning |
|------|---------|
| Pre-Vacation Prep | The manually triggered preparation window before Hamel leaves, where human-in-the-loop reauth and manual fixes are allowed. |
| Vacation Readiness Audit | The deterministic checklist that evaluates whether the system is safe to leave unattended. |
| Vacation Mode | The explicit unattended operating state active between a start time and end date. |
| Go / No-Go | The final departure recommendation emitted by the readiness audit. |
| Tier 0 | Control-plane systems that must work or the system is not trustworthy. |
| Tier 1 | Personal comms/reminder systems that must work for unattended utility. |
| Tier 2 | Important dependency systems whose failure should warn or degrade, but not always block departure. |
| Tier 3 | Non-blocking systems whose failure should be visible but not drive no-go. |
| Deterministic Remediation | A bounded, explicitly allowed repair action such as retry, restart, reload, resync, or rerun smoke. |
| Interactive Reauth | Any repair requiring browser auth, password entry, MFA, consent screen interaction, or Hamel’s direct approval. |
| Vacation Incident Ledger | The structured record of failures, repair attempts, results, and unresolved issues during the vacation window. |

---

### Requirement 1 - Readiness Audit

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Hamel, I want one command to tell me whether the system is safe to leave unattended for up to `30` days so that I have an explicit go / no-go answer. | Must not require reading multiple dashboards manually. |
| Accepted | As an operator, I want the audit to evaluate Tier 0, Tier 1, Tier 2, and Tier 3 systems with deterministic rules so that the result is explainable and repeatable. | No hidden prompt-only logic. |
| Accepted | As Hamel, I want the audit to produce `PASS`, `WARN`, `FAIL`, or `NO-GO` so that the departure decision is unambiguous. | `NO-GO` should block departure confidence. |
| Accepted | As an operator, I want the audit to include exact evidence timestamps and latest verification results so that stale state is not confused with live breakage. | Must use freshness-aware inputs. |

#### Required systems for readiness audit

Tier 0 (`NO-GO` if broken):
- OpenClaw gateway
- Telegram delivery
- `main` agent delivery
- `monitor` agent delivery
- Mission Control reachability
- Tailscale reachability / remote access viability
- runtime integrity check
- green baseline
- critical synthetic probe

Mission Control and Tailscale are treated as local-readiness and tailnet-viability proxies only. They prove the operator can reach the local control plane and tailnet, not internet-wide remote reachability.

Tier 1 (`NO-GO` if broken after allowed remediation):
- Gog headless auth
- Calendar reminders end-to-end
- Apple Reminders end-to-end
- Morning Brief end-to-end
- Gmail / inbox triage
- fitness service
- Schwab auth / quote smoke
- backtester app health using existing readiness / market-data surfaces plus the local app probe path in v1
- GitHub machine identity consistency (`cortana-hd`)
- browser CDP watchdog path

Tier 2 (`WARN` if broken):
- market scans
- trading precompute / watchlist refresh
- selected backtester support paths that do not block reminders/comms/control plane

Tier 3 (`INFO` only):
- secondary nice-to-have summaries or low-value informational scans

#### Go / No-Go rule

- `NO-GO` if any Tier 0 system is red.
- `NO-GO` if any Tier 1 system remains red after all allowed deterministic remediation has been attempted and verified.
- `FAIL` if readiness execution itself is incomplete or cannot verify required systems.
- `WARN` if Tier 0 and Tier 1 are green but one or more Tier 2 systems are degraded.
- `PASS` only if Tier 0 and Tier 1 are green and no unresolved Tier 2 issue exceeds the configured warning threshold.

#### Readiness decision matrix

The readiness command must evaluate in this order and stop as soon as the highest-severity terminal condition is known:

1. Any Tier 0 red result immediately yields `NO-GO`.
2. Any Tier 1 red result triggers the full deterministic remediation ladder for that system.
3. If a Tier 1 system is still red after remediation and verification, the overall result is `NO-GO`.
4. If readiness execution cannot complete or cannot produce evidence for a required check, the overall result is `FAIL`.
5. If all Tier 0 and Tier 1 checks are green but one or more Tier 2 checks are degraded past their configured threshold, the overall result is `WARN`.
6. Only when Tier 0 and Tier 1 are green and Tier 2 has not crossed its warning threshold may the result be `PASS`.

Stale degraded evidence must be overwritten by newer healthy verification for the same system before the final result is computed. The command must never blend stale red evidence with newer green evidence into an ambiguous intermediate state.

---

### Requirement 2 - Pre-Vacation Prep Workflow

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Hamel, I want to trigger vacation prep manually by command or natural language so that I stay in control of when preparation begins. | Natural language may recommend timing, but must not auto-enable vacation mode. |
| Accepted | As Hamel, I want the system to scan my Google Calendar travel plans and recommend an ideal prep window so that I can start prep about `24` hours before departure. | Recommendation only, not automatic activation. |
| Accepted | As an operator, I want prep to explicitly surface any systems requiring interactive reauth before departure so that nothing human-dependent remains hidden. | This is the right time to refresh fragile auth. |
| Accepted | As Hamel, I want real Telegram test messages sent to `monitor` during prep so that delivery health is verified end to end, not assumed. | Prefix should clearly indicate vacation preflight. |
| Accepted | As an operator, I want prep to run exact smoke tests for Gog, reminders, Morning Brief, Schwab, Mission Control, Tailscale, and backtester surfaces so that the audit result is grounded in live behavior. | Dry-run alone is not enough. |

#### Prep workflow requirements

- Prep must be manually triggerable by command.
- Prep must also be triggerable by natural language intent such as “I leave tomorrow for 10 days”.
- Natural-language activation is an edge wrapper over deterministic CLI/state transitions only; it may request recommendation or prep, but it must not mutate vacation state directly.
- Prep may recommend an ideal audit window using travel/flight calendar context, but the recommendation must be advisory only.
- Prep timing must be deterministic: compute the preferred prep start in Hamel’s travel timezone when available, otherwise fall back to the configured operator timezone, and default the recommendation to approximately `24` hours before departure.
- Prep must be allowed to request Hamel’s approval for interactive reauth where needed.
- Prep must not auto-perform interactive reauth without Hamel’s explicit involvement.
- Prep must record which auth or approval steps were completed.
- Prep must re-run verification after any manual auth refresh step.
- Prep must mark any still-pending interactive auth dependency explicitly as `AUTH_REQUIRED` rather than silently passing it.

---

### Requirement 3 - Vacation Mode State Machine

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Hamel, I want vacation mode to be an explicit state with a start time and end date so that unattended policy is predictable and reversible. | Auto-disable required. |
| Accepted | As an operator, I want vacation mode to continue the high-value system behavior I still care about so that the system remains useful while I am away. | Market, fitness, news, reminders, and Morning Brief stay on. |
| Accepted | As Hamel, I want vacation mode to auto-disable at the configured end date and send a `normal ops resumed` summary so that the system returns to standard behavior cleanly. | Must restore any paused policies. |
| Accepted | As an operator, I want vacation mode to disable `Daily Auto-Update` so that unattended stability is prioritized over freshness. | This is the only explicitly approved disablement so far. |

#### Vacation mode behavior

While active, vacation mode must:

- keep market, fitness, news, and Morning Brief running
- keep reminders and comms running
- keep health and maintenance checks running
- disable `🔄 Daily Auto-Update (notify Hamel)`
- preserve bounded self-heal
- prevent autonomous interactive reauth
- maintain morning and evening operator summaries to `monitor`

Vacation mode enable semantics:

- enable may happen only after a readiness run returns `PASS` or `WARN`
- `PASS` means all Tier 0 and Tier 1 checks are green and Tier 2 is within threshold
- `WARN` means Tier 0 and Tier 1 are green, and the operator accepts the remaining Tier 2 degradation
- enable must persist the canonical vacation window, write the runtime mirror, and disable `Daily Auto-Update` in that order
- enable must not run if any Tier 0 or unresolved Tier 1 check is red

Vacation mode disable semantics:

- disable may be manual or automatic
- manual disable must be idempotent and safe when vacation mode is already inactive
- auto-expire must trigger at the configured `end_at` and must be the same code path used to restore paused state
- disable must restore `Daily Auto-Update` before emitting the `normal ops resumed` summary
- disable must close out the vacation ledger window and preserve the historical audit trail

Vacation mode auto-expire semantics:

- auto-expire must only use the stored `end_at` from the canonical vacation window
- auto-expire must not depend on wall-clock heuristics or best-effort polling alone
- if the process restarts after the end time, the next guard or summary run must observe the expired state and complete disablement

Auto-disable must:

- occur at the configured end date/time
- restore `Daily Auto-Update`
- restore any other vacation-specific policy toggles that were changed
- emit one concise `normal ops resumed` summary to `monitor`
- close or summarize the vacation incident ledger window

---

### Requirement 4 - Deterministic Remediation Policy

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Hamel, I want the system to try safe, bounded repairs while I’m away so that common failures resolve without intervention. | Must be transparent and logged. |
| Accepted | As an operator, I want every permitted repair action to be predefined so that “self-healing” means deterministic repair, not freeform experimentation. | No hidden improvisation. |
| Accepted | As Hamel, I want to be alerted when deeper investigation begins so that I know the system moved beyond simple repair. | Awareness is required. |

#### Allowed automatic repair ladder

The remediation ladder should be explicit and bounded:

1. bounded retry
2. service restart or launchd reload
3. runtime config resync
4. env / plist restoration
5. stale session rotation
6. exact smoke rerun and verification

Additional rules:

- Each repair step must be logged.
- Each repair step must be followed by verification.
- If verification fails, the next allowed step may run.
- If the ladder is exhausted, the system must alert and stop.
- No interactive reauth while vacation mode is active.
- No package upgrades, repo changes, or open-ended code mutation while unattended.
- Deeper agent investigation is permitted only after an alert and only within an explicitly defined approval boundary in the later technical design.

---

### Requirement 5 - Vacation Summary and Alerting

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Hamel, I want a short morning and evening vacation summary in Telegram so that I can see whether the system is healthy from my phone. | Must be compact. |
| Accepted | As an operator, I want summaries to route through `monitor` so that vacation status stays in one operator channel. | No duplicate routing. |
| Accepted | As Hamel, I want only actionable problem alerts outside those summaries so that my phone does not get spammed. | Summary and alerts are separate products. |

#### Summary contract

The daily vacation summary must:

- send to `monitor`
- run morning and evening in Hamel’s configured local timezone
- default to `08:00` and `20:00` local time until user customization exists
- be compact and mobile-readable
- include overall state (`GREEN`, `YELLOW`, `RED`)
- include grouped status for:
  - control plane
  - reminders / comms
  - market / fitness / news
- include self-heal count in the last `24h`
- include human-required blockers count
- include at most one short line describing any active degradation
- follow a fixed operator-first text template so the same state always renders the same shape

The machine-readable summary payload must include at minimum:

- `window_id`
- `period`
- `generated_at`
- `timezone`
- `overall_state`
- `control_plane_state`
- `reminders_state`
- `market_fitness_news_state`
- `self_heal_count_24h`
- `human_required_blockers`
- `active_degradation`
- `next_action`
- `delivery_channel`

The text message should be derived from that payload and stay short enough to read on mobile without scrolling a long paragraph.

The summary must not become a large heartbeat essay.

#### Alert contract

Vacation-mode alerts must:

- be actionable failures only
- include what broke
- include what repair steps were attempted
- include whether the failure remains unresolved
- distinguish between `degraded`, `recovered`, and `human-required`

---

### Requirement 6 - Vacation Incident Ledger

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Hamel, I want every failure, remediation attempt, and unresolved issue during vacation mode logged in one place so that I can review what happened when I return. | Supports retrospective and hardening. |
| Accepted | As an operator, I want the ledger to be structured and queryable so that future monitors can suppress stale state and reason about recurrence. | Should not be freeform text only. |

#### Ledger requirements

Vacation mode state and the vacation incident ledger must be stored canonically in Postgres.

Vacation mode uses its own canonical vacation tables and incident ledger. It may reuse autonomy taxonomy, system keys, and `incident_key` references where helpful, but it does not write directly into autonomy tables.

The canonical incident model must be first-class, not implied through check or action rows. Each vacation-window incident should capture:

- incident id
- window id
- first observed time
- last observed time
- system / component key
- tier
- current status (`open`, `degraded`, `human_required`, `resolved`)
- whether human action is required
- latest check evidence
- latest action evidence
- resolution reason
- resolution time

Repo or runtime files may mirror the currently active vacation window only to support local script execution, but those files must not be treated as the system of record.

The ledger must record at minimum:

- incident id
- first observed time
- last observed time
- system / component
- tier
- symptom
- freshness timestamp of evidence
- remediation actions attempted
- remediation result for each action
- final verification result
- whether human intervention was required
- whether the issue was resolved during the vacation window

The ledger should support post-vacation reporting such as:

- total incidents
- total self-healed incidents
- unresolved incidents
- top recurring failure types
- which deterministic remediations were most effective

---

### Requirement 7 - System Scope and Tiering

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an operator, I want explicit tier membership for every vacation-relevant system so that alert severity and readiness decisions are not subjective. | Must be config-driven. |
| Accepted | As Hamel, I want the system to check the exact things I will rely on while away, not just generic process health. | Remote access and dashboards matter. |

#### Required in-scope systems

Tier 0 / control plane:
- OpenClaw gateway
- Telegram delivery
- `main` agent delivery
- `monitor` agent delivery
- Mission Control availability
- Tailscale remote access viability
- runtime integrity check
- green baseline
- critical synthetic probe

Tier 1 / user value and critical dependencies:
- Gog headless auth
- Calendar reminder delivery path
- Apple Reminders delivery path
- Morning Brief delivery path
- Gmail / inbox triage path
- fitness service health
- Schwab auth and quote smoke
- backtester app health
- GitHub machine identity consistency
- browser CDP health

Tier 2 / valuable but not immediate no-go if degraded:
- trading watchlist support flows
- trading precompute / notify support paths
- Polymarket or secondary market intel jobs
- nonessential dashboard enrichments

Tier 3 / informational:
- low-value informational scans or convenience outputs that do not affect away-from-keyboard trust

#### Tier 2 freshness thresholds

Tier 2 freshness must be class-based, not one universal timeout:

- market / trading Tier 2
  - `INFO` on first failure
  - `WARN` if degradation persists for `30m` during market hours
  - `WARN` if degradation persists into the final `60m` before the next market open
  - `WARN` on `2` consecutive missed runs

- fitness / news Tier 2
  - `INFO` on first failure
  - `WARN` on `2` consecutive failures
  - `WARN` if stale for `24h`

- background intel / secondary enrichments
  - `INFO` on first failure
  - `WARN` on `2` consecutive failures
  - `WARN` if stale for `12h`

Global freshness rule:

- if a healthy verification result is newer than the degraded evidence, the degraded state must clear immediately
- stale degraded evidence must never remain `WARN` after a fresh healthy verification succeeds

---

## Appendix

Include any supporting material that helps the next implementer.

### Additional Considerations

This repo should remain LLM agnostic.

That means:

- name exact repos, files, services, tables, and tests when they matter
- encode rules in deterministic code, typed config, or explicit schemas
- do not leave essential behavior only in prompt wording
- make the scope understandable without hidden project context

For this project specifically, the following must not remain only as prompt instructions:

- go / no-go logic
- tier definitions
- vacation mode enable / disable state
- allowed automatic remediation ladder
- summary schema
- incident ledger schema
- vacation end-date behavior

### User Research

Observed operator requirements from this planning discussion:

- Hamel wants a system that can be trusted for up to `30` days unattended.
- Hamel expects to trigger prep around `24` hours before departure.
- Hamel wants the system to inspect travel plans and recommend the best prep window, but not auto-enable vacation mode.
- Hamel wants real end-to-end Telegram tests during prep.
- Hamel wants market, fitness, and news lanes to keep running while away.
- Hamel wants Morning Brief to continue in normal form.
- Hamel wants `Daily Auto-Update` disabled during vacation mode.
- Hamel wants deterministic self-heal, not freeform autonomous debugging.
- Hamel wants every repair and failure logged so the system can improve retrospectively.
- Hamel wants daily morning and evening vacation summaries sent to `monitor`.
- Hamel wants the system to auto-disable vacation mode at the configured end date and send a `normal ops resumed` summary.

### Resolved Decisions

- Default morning and evening summary times are `08:00` and `20:00` in the vacation window's configured local timezone until user customization exists.
- Backtester app health in v1 relies on existing readiness and market-data surfaces plus the existing local app probe path; a new dedicated endpoint is out of scope for v1.
- Vacation mode uses its own canonical vacation tables and incident ledger; autonomy taxonomy, system keys, and `incident_key` references may be reused, but vacation mode does not write directly into autonomy tables.
- Mission Control and Tailscale are accepted as local-readiness and tailnet proxies only, not proof of Internet-wide reachability.
- Natural-language activation remains allowed only as an edge wrapper over deterministic CLI/state transitions.
