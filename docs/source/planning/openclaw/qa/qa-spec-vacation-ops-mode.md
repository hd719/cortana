# QA Specification - Vacation Ops Mode and Readiness System

**Document Status:** Draft v1

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | Hamel |
| Epic | Vacation Ops Mode and Readiness System |

---

## Purpose

This QA spec defines how `Vacation Ops Mode and Readiness System` will be verified before rollout.

It is written so that:

- a human tester can execute it manually
- an LLM or subagent can execute it without hidden context
- failures can be mapped back to exact requirements in the PRD and Tech Spec
- readiness, safety, and unattended-operation guarantees can be proven with evidence rather than opinion

This document is intentionally more operationally specific than a generic test plan.

It covers:

- pre-vacation prep behavior
- readiness scoring and go / no-go logic
- vacation mode state transitions
- deterministic remediation behavior
- daily summary behavior
- incident ledger correctness
- restoration and auto-disable behavior
- false-positive / stale-state suppression

It does not assume prior knowledge of the implementation beyond the linked planning docs.

Related docs:

- [PRD](../prd/prd-vacation-ops-mode.md)
- [Tech Spec](../techspec/techspec-vacation-ops-mode.md)

---

## Quality Goals

The feature is acceptable only if it proves all of the following:

1. It gives an unambiguous answer before departure.
2. It does not silently ignore broken Tier 0 / Tier 1 systems.
3. It does not perform interactive reauth autonomously during active vacation mode.
4. It performs only deterministic bounded repair while away.
5. It does not create stale or contradictory health state after recovery.
6. It produces compact operator summaries suitable for Telegram/mobile reading.
7. It restores normal ops cleanly after the vacation window ends.

---

## Scope

### In Scope

- vacation recommendation flow
- pre-vacation prep flow
- readiness audit flow
- vacation mode enable / active / disable flow
- auto-disable on end date
- morning summary and evening summary
- Tier 0 / Tier 1 / Tier 2 / Tier 3 classification behavior
- deterministic remediation ladder behavior
- Postgres-backed vacation state and ledger behavior
- runtime mirror file synchronization behavior
- `Daily Auto-Update` pause and restore behavior
- Tier 2 threshold handling
- stale-state clearance when fresh healthy evidence exists

### Out of Scope

- business quality of Morning Brief content itself
- redesign of Mission Control UI
- redesign of Telegram plugin behavior outside vacation-mode outputs
- provider-side availability beyond what local smoke tests can detect
- open-ended autonomous code mutation or interactive auth UX design

---

## Test Environments

### Environment A - Local Dev / Dry Validation

Purpose:
- validate CLI contracts, state transitions, summary formatting, and DB writes without disturbing live unattended ops

Requirements:
- local repo checkout on branch with feature changes
- Postgres available
- test DB or isolated schema if needed
- OpenClaw config readable
- ability to stub Telegram send and provider checks

### Environment B - Staging / Controlled Live Validation

Purpose:
- validate actual service interactions, Telegram delivery, real gateway health, and bounded self-heal on a machine similar to production

Requirements:
- OpenClaw gateway running
- Telegram account available
- Mission Control reachable
- Tailscale available
- access to Gog, Apple Reminders, fitness, and market data paths

### Environment C - Production-Like Mac Mini Validation

Purpose:
- final end-to-end proof that the system works with the real unattended stack

Requirements:
- same Mac mini or equivalent host used for real unattended ops
- real Telegram monitor lane
- real OpenClaw runtime state
- real `gog` auth store
- real service launch agents
- real cron state and mission-control/backtester surfaces

---

## Entry Criteria

Testing may begin only when all of the following are true:

- PRD is approved
- Tech Spec is approved
- migration and config shapes are implemented
- deterministic CLI exists
- required DB tables are created
- cron wiring for vacation summary and auto-disable exists
- at least one test fixture can simulate Tier 0 / Tier 1 / Tier 2 failures deterministically

---

## Exit Criteria

The feature is acceptable only when all of the following are true:

- all P0 and P1 scenarios in this spec pass
- no blocker remains in Tier 0 or Tier 1 logic
- no stale degraded state survives a newer healthy verification in tested scenarios
- no active-vacation flow performs autonomous interactive auth
- `Daily Auto-Update` is always restored on disable or expiry
- morning and evening summaries are confirmed compact and readable on Telegram/mobile
- at least one full end-to-end rehearsal from `prep` through `enable` through `disable` has passed in a production-like environment

---

## Severity Model

| Severity | Meaning |
|----------|---------|
| P0 | Feature is unsafe or untrustworthy for unattended use. |
| P1 | Core vacation workflow or a Tier 0 / Tier 1 guarantee is broken. |
| P2 | Feature works but has degraded operator quality, incomplete telemetry, or non-blocking incorrectness. |
| P3 | Cosmetic, wording, or convenience issue with no impact on correctness. |

---

## Traceability Matrix

| PRD Requirement | QA Coverage Section |
|-----------------|--------------------|
| Requirement 1 - Readiness Audit | Sections A, B, C, D |
| Requirement 2 - Pre-Vacation Prep Workflow | Sections A, B, E |
| Requirement 3 - Vacation Mode State Machine | Sections F, G, H |
| Requirement 4 - Deterministic Remediation Policy | Sections I, J |
| Requirement 5 - Vacation Summary and Alerting | Sections K, L |
| Requirement 6 - Vacation Incident Ledger | Sections M, N |
| Requirement 7 - System Scope and Tiering | Sections B, C, D, O |

---

## Test Data / Fixtures

Test data should include:

- one valid vacation window with start/end times in `America/New_York`
- one travel calendar event representing departure within `24h`
- one healthy Tier 0 / Tier 1 baseline snapshot
- one unhealthy Tier 0 snapshot
- one unhealthy but repairable Tier 1 snapshot
- one Tier 2 stale-but-not-yet-warn state
- one Tier 2 stale-and-warn state
- one stale degraded result older than a newer healthy verification
- one scenario requiring interactive auth to recover

Fixture categories:

- Postgres rows for vacation windows / runs / results / actions
- cron job state fixtures
- provider smoke-test fixtures
- Telegram send success / failure fixtures
- gateway / Mission Control / Tailscale / Schwab / Gog success and failure fixtures

---

## Detailed QA Stories and Scenarios

### Section A - Recommendation and Triggering

#### QA Story A1 - Manual command creates a recommendation without enabling vacation mode

As an operator, I want `recommend` to suggest a prep window without mutating vacation mode so that travel awareness cannot accidentally enable unattended policy.

Acceptance criteria:
- `recommend` returns a recommendation payload
- no row becomes `active` in `cortana_vacation_windows`
- no runtime mirror file indicates active vacation mode
- no cron is paused

Verification:
- check CLI output
- check DB rows
- check `~/.openclaw/state/vacation-mode.json`
- verify `Daily Auto-Update` remains enabled

Severity if failed: P1

#### QA Story A2 - Natural language intent routes into deterministic recommendation path

As Hamel, I want a natural-language request such as “I leave tomorrow for 10 days” to call the deterministic vacation flow rather than directly mutating runtime state.

Acceptance criteria:
- natural-language entry creates the same recommendation result as CLI
- output is traceable to one CLI-equivalent run record
- no direct state mutation happens until explicit enable flow later

Verification:
- compare natural-language result to `recommend --json`
- confirm a `cortana_vacation_runs` row exists with `run_type=recommend`
- confirm no active vacation window is created

Severity if failed: P2

---

### Section B - Tier Classification and Readiness Scoring

#### QA Story B1 - Tier 0 failure forces NO-GO

As an operator, I want any Tier 0 failure to force `NO-GO` so that control-plane trust is never overstated.

Acceptance criteria:
- readiness outcome is exactly `NO-GO`
- failing Tier 0 system is explicitly named
- no Tier 2 success can mask the Tier 0 failure

Test cases:
- gateway down
- Telegram direct send failure
- `main` delivery failure
- `monitor` delivery failure
- Mission Control unavailable
- Tailscale unavailable
- critical synthetic probe red

Evidence required:
- readiness result JSON
- individual check rows in `cortana_vacation_check_results`

Severity if failed: P0

#### QA Story B2 - Tier 1 failure that repairs successfully does not remain NO-GO

As an operator, I want a repairable Tier 1 issue to transition from failed to healthy if deterministic remediation succeeds so that the system is not falsely blocked.

Acceptance criteria:
- initial check fails
- allowed remediation runs
- verification rerun succeeds
- final readiness is not `NO-GO` solely because of the resolved issue
- remediation steps are logged

Test cases:
- Gog env/plist drift repaired by env restoration
- stale session rotation restores a delivery path
- runtime sync restores a stale cron path

Severity if failed: P1

#### QA Story B3 - Tier 2 warning thresholds apply by class, not globally

As an operator, I want Tier 2 warning thresholds to differ for market, fitness/news, and background intel so that urgency is proportional to operational value.

Acceptance criteria:
- market Tier 2 warns after `30m` during market hours or `2` consecutive misses
- fitness/news warns after `2` consecutive failures or `24h` stale
- background intel warns after `2` consecutive failures or `12h` stale
- no other class accidentally inherits the wrong threshold

Severity if failed: P1

#### QA Story B4 - Fresh healthy verification clears stale degraded state

As an operator, I want a newer healthy verification to clear older degraded evidence immediately so that stale state does not continue to alert.

Acceptance criteria:
- degraded check result exists with older timestamp
- healthy verification exists with newer timestamp
- aggregate readiness and summaries show the system as healthy for that component
- no lingering `WARN` remains for the stale degraded evidence

Severity if failed: P1

#### QA Story B5 - Stale readiness results are rejected for enable

As Hamel, I want `enable` to reject a readiness result that is outside the configured freshness window so that an old green run cannot authorize unattended mode.

Acceptance criteria:
- a readiness result older than the default `6h` freshness window is treated as stale
- `enable` fails even if that older result was previously `PASS`
- the failure explains that a newer or fresher readiness run is required

Severity if failed: P0

---

### Section C - Readiness Coverage of Required Systems

#### QA Story C1 - Readiness includes every Tier 0 system exactly once

As Hamel, I want the readiness audit to check all must-not-fail control-plane systems so that the departure decision is complete.

Acceptance criteria:
- readiness includes: gateway, Telegram, `main`, `monitor`, Mission Control, Tailscale, runtime integrity, green baseline, critical synthetic probe
- each appears in result rows with a stable `system_key`
- no Tier 0 system is silently omitted

Severity if failed: P0

#### QA Story C2 - Readiness includes every Tier 1 system exactly once

As Hamel, I want the readiness audit to check Gog, reminders, Morning Brief, Gmail/inbox, fitness, Schwab, backtester, GitHub identity, and browser CDP so that the unattended system is actually usable.

Acceptance criteria:
- each required Tier 1 system appears in result rows
- each check has evidence and status
- `GitHub identity` explicitly verifies `cortana-hd`

Severity if failed: P1

#### QA Story C3 - Browser CDP behaves as Tier 1

As Hamel, I want browser CDP to be treated as Tier 1 so that remote trust includes browser-dependent functionality.

Acceptance criteria:
- a broken browser CDP check contributes to `NO-GO`
- a healthy browser CDP check contributes positively to Tier 1 completeness

Severity if failed: P1

---

### Section D - Go / No-Go Output Contract

#### QA Story D1 - Human-readable readiness output is concise and exact

As Hamel, I want the readiness result to be readable on mobile and still precise so that I can act on it quickly before departure.

Acceptance criteria:
- one final outcome: `PASS`, `WARN`, `FAIL`, or `NO-GO`
- top blockers shown first
- no giant essay
- exact failed systems and whether remediation was attempted are visible

Severity if failed: P2

#### QA Story D2 - Machine-readable readiness output is complete

As an implementing agent, I want the JSON result to contain all check outcomes and final state so that downstream automation can reason about it without scraping prose.

Acceptance criteria:
- output contains final outcome
- contains all systems checked
- contains timestamps, tier, status, freshness, and remediation flags
- schema is stable and typed

Severity if failed: P1

#### QA Story D3 - Summary contract is exact and payload-driven

As an implementing agent, I want the vacation summary payload to be the source of truth so that text rendering is deterministic and does not infer missing state.

Acceptance criteria:
- summary payload includes the active window id, period, overall status, readiness outcome, incident counts, self-heal count, human-required count, and pause/restore status
- summary text is a direct rendering of that payload
- summary wording does not depend on scraping prior Telegram text or freeform check prose

Severity if failed: P1

---

### Section E - Pre-Vacation Prep and Interactive Reauth Handling

#### QA Story E1 - Prep can request interactive auth before departure

As Hamel, I want the system to explicitly ask for auth-related manual steps during prep so that hidden human dependencies are surfaced before I leave.

Acceptance criteria:
- prep identifies auth-required failures
- prep marks them as requiring human approval/action
- prep does not pretend they are healed until re-verification passes

Examples:
- Gog token refresh needed
- Schwab auth refresh needed
- browser-linked auth path expired

Severity if failed: P1

#### QA Story E2 - Active vacation mode never performs interactive reauth autonomously

As Hamel, I want active vacation mode to refuse autonomous interactive reauth so that unattended behavior remains bounded and predictable.

Acceptance criteria:
- auth-required incident during vacation mode is logged as degraded/human-required
- no browser auth or TTY prompt flow is initiated automatically
- alert explicitly says human approval is required

Severity if failed: P0

#### QA Story E3 - Prep sends real Telegram end-to-end test messages

As Hamel, I want real preflight Telegram test messages sent to `monitor` so that delivery is verified end to end, not assumed.

Acceptance criteria:
- at least one real `Vacation Preflight Test` message is received in `monitor`
- test is linked to a prep run record
- send success/failure is recorded deterministically

Severity if failed: P1

---

### Section F - Vacation Mode Enable

#### QA Story F1 - Enable succeeds only after readiness allows it

As an operator, I want `enable` to be blocked when readiness is `NO-GO` or `FAIL` so that unattended mode cannot be entered unsafely.

Acceptance criteria:
- `enable` fails if no current acceptable readiness result exists
- `enable` succeeds only after readiness is `PASS` or allowed `WARN`
- the resulting active window is persisted in Postgres

Severity if failed: P0

#### QA Story F2 - Enable pauses Daily Auto-Update and records the pause

As an operator, I want vacation mode to disable `🔄 Daily Auto-Update (notify Hamel)` and remember that action so that unattended stability is prioritized and cleanup is reversible.

Acceptance criteria:
- cron job id `af9e1570-3ba2-4d10-a807-91cdfc2df18b` is disabled on enable
- pause is recorded in `state_snapshot` and runtime mirror
- other approved lanes remain enabled

Severity if failed: P1

#### QA Story F3 - Enable writes both Postgres canonical state and runtime mirror state

As an operator, I want active vacation mode visible in both canonical and runtime-friendly forms so that cron guards can work fast without becoming source of truth.

Acceptance criteria:
- active row exists in `cortana_vacation_windows`
- `~/.openclaw/state/vacation-mode.json` is written
- if the mirror is removed and re-derived, it matches Postgres

Severity if failed: P1

#### QA Story F4 - Enable transition ordering is deterministic

As Hamel, I want the activation sequence to happen in a fixed order so that a partial failure cannot leave vacation mode half-enabled.

Acceptance criteria:
- the implementation records readiness verification before state mutation
- the active window is persisted before the mirror and cron pause
- cron pause happens before activation summary delivery
- if summary delivery fails, the active window and paused-job state remain committed

Severity if failed: P1

---

### Section G - Active Vacation Operation

#### QA Story G1 - Market, fitness, news, and Morning Brief continue while vacation mode is active

As Hamel, I want the system to keep generating normal value while I’m away so that vacation mode does not become “safe but useless.”

Acceptance criteria:
- Morning Brief still runs
- market jobs still run
- fitness jobs still run
- news/intel jobs still run
- only approved pause(s) apply

Severity if failed: P1

#### QA Story G2 - Vacation summaries are compact and sent twice daily to monitor

As Hamel, I want a morning and evening operational summary while away so that I know the system is alive without reading a long heartbeat.

Acceptance criteria:
- one morning summary and one evening summary while active
- routed to `monitor`
- compact text, one short Telegram message each
- summary includes: overall state, grouped subsystem status, self-heals count, human-required count

Severity if failed: P1

#### QA Story G3 - Alerts remain actionable and separate from summaries

As Hamel, I want real failures to alert immediately and not be buried in daily summaries.

Acceptance criteria:
- actionable failures produce direct alerts outside the summary schedule
- summaries do not duplicate the same incident excessively
- recovered incidents can emit a concise recovery notice if configured

Severity if failed: P2

---

### Section H - Auto-Disable and Return to Normal

#### QA Story H1 - Vacation mode auto-disables at the configured end time

As Hamel, I want unattended mode to expire automatically so that the system returns to normal without manual cleanup.

Acceptance criteria:
- mode disables at or immediately after end time
- active row changes to completed/expired state
- runtime mirror clears or updates to inactive

Severity if failed: P1

#### QA Story H2 - Daily Auto-Update is restored on disable

As an operator, I want paused update behavior restored when vacation mode ends so that normal operations resume cleanly.

Acceptance criteria:
- paused job is re-enabled on manual disable and auto-expire
- restoration is logged
- failure to restore is visible and does not silently pass

Severity if failed: P1

#### QA Story H3 - Normal ops resumed summary is sent once

As Hamel, I want one concise “normal ops resumed” message so that I know vacation mode ended successfully.

Acceptance criteria:
- exactly one resume summary per disable event
- sent to `monitor`
- includes whether restore actions succeeded

Severity if failed: P2

#### QA Story H4 - Auto-expire follows the same ordered teardown and is idempotent

As Hamel, I want auto-expire to follow the same safe cleanup order as manual disable so that expiration cannot skip restoration work.

Acceptance criteria:
- auto-expire restores paused jobs before final completion
- the runtime mirror is cleared or archived after restore is committed
- the resume summary is emitted once even if the expiry job retries

Severity if failed: P1

---

### Section I - Deterministic Remediation Ladder

#### QA Story I1 - Remediation follows the allowed order only

As an operator, I want the repair ladder to follow the approved sequence so that self-heal remains deterministic and auditable.

Allowed sequence:
1. retry
2. restart/reload
3. runtime sync
4. env/plist restoration
5. stale session rotation
6. rerun exact smoke

Acceptance criteria:
- steps never occur out of order without explicit per-system policy exception
- each step is logged before moving to the next
- the ladder stops when verification succeeds

Severity if failed: P0

#### QA Story I2 - Remediation stops after bounded failure

As Hamel, I want the system to stop after the allowed ladder is exhausted so that it does not continue into open-ended repair attempts.

Acceptance criteria:
- no step beyond the configured ladder is attempted
- unresolved failure triggers alert
- unresolved state remains clearly marked in ledger and summaries

Severity if failed: P0

#### QA Story I3 - Deeper investigation is visible to Hamel

As Hamel, I want any deeper post-alert investigation to be visible so that I know the system moved beyond simple repair.

Acceptance criteria:
- a distinct event is logged if deeper investigation is invoked
- alert text communicates that the system moved beyond deterministic repair
- deterministic ladder result remains distinguishable from deeper investigation outcome

Severity if failed: P2

---

### Section J - Remediation by Example Failure Class

#### QA Story J1 - Service restart path

As an operator, I want service-backed failures to follow `retry -> restart -> verify` so that routine launchd issues recover automatically.

Candidate systems:
- OpenClaw gateway
- Mission Control
- fitness service

Acceptance criteria:
- restart action is logged with service or launchd label
- verification succeeds or explicit failure remains

Severity if failed: P1

#### QA Story J2 - Runtime sync path

As an operator, I want stale runtime-config issues to follow `retry -> runtime sync -> verify` so that merge-vs-runtime drift is handled deterministically.

Candidate systems:
- stale cron runtime config
- stale helper path usage

Acceptance criteria:
- runtime sync step is explicit
- verification uses exact smoke, not inferred health

Severity if failed: P1

#### QA Story J3 - Env/plist restoration path

As an operator, I want env drift issues to restore canonical env state deterministically so that Gog-like failures can recover safely.

Acceptance criteria:
- env restore action is logged
- verification checks the real headless path
- active vacation mode still forbids interactive reauth if restore fails

Severity if failed: P1

---

### Section K - Summary Formatting and Mobile Constraints

#### QA Story K1 - Summary text fits one short Telegram message

As Hamel, I want the daily summary readable from my phone without scrolling through a giant heartbeat.

Acceptance criteria:
- message remains compact
- no large prose block
- grouped sections are terse
- message does not split into multipart delivery under healthy or moderately degraded conditions

Severity if failed: P2

#### QA Story K2 - Summary reflects current truth, not stale historical state

As Hamel, I want the summary to describe what is currently wrong, not what was wrong earlier in the day and already recovered.

Acceptance criteria:
- recovered incidents do not remain in active degraded rollup if a newer healthy check exists
- summary uses freshness-aware aggregation
- stale warnings are suppressed

Severity if failed: P1

---

### Section L - Alert Formatting and Routing

#### QA Story L1 - Vacation alerts route only to monitor

As Hamel, I want vacation operational messages consolidated into the `monitor` lane so that I know where to look while away.

Acceptance criteria:
- summaries route to `monitor`
- actionable vacation-mode alerts route to `monitor`
- duplicate delivery to `main` does not happen unless explicitly configured

Severity if failed: P2

#### QA Story L2 - Alert content includes failure + attempted fix + outcome

As Hamel, I want each alert to tell me what broke, what the system tried, and whether it worked so that I can judge urgency quickly.

Acceptance criteria:
- failure named
- steps attempted listed briefly
- final state shown as unresolved / recovered / human-required

Severity if failed: P1

---

### Section M - Postgres Ledger Correctness

#### QA Story M1 - Every run creates durable records

As an operator, I want every prep/readiness/enable/disable/summary run persisted so that there is a durable audit trail.

Acceptance criteria:
- `cortana_vacation_runs` row created for each run
- `started_at`, `completed_at`, and final `state` are populated correctly
- `summary_payload` exists for summary runs

Severity if failed: P1

#### QA Story M2 - Every check result is traceable and queryable

As an operator, I want every system check stored with tier, timestamps, freshness, and details so that debugging and retrospective review are possible.

Acceptance criteria:
- `cortana_vacation_check_results` rows exist for each system check
- rows can be joined back to the originating run
- stale-state resolution is visible through timestamps

Severity if failed: P1

#### QA Story M3 - Every remediation action is recorded

As Hamel, I want to know later exactly what the system tried while I was away.

Acceptance criteria:
- every step in the ladder creates a `cortana_vacation_actions` row
- `action_status` and `verification_status` are accurate
- records remain queryable after the vacation window closes

Severity if failed: P1

#### QA Story M4 - One incident can span multiple checks and actions

As Hamel, I want a single incident to remain the identity for repeated failures and repairs so that the ledger reads like an operational story instead of a pile of unrelated rows.

Acceptance criteria:
- the incident ledger records one incident per ongoing degradation class/window combination
- multiple failed checks and remediation attempts can attach to the same incident
- the incident closes only when newer healthy evidence supersedes the degraded state

Severity if failed: P1

---

### Section N - Retrospective and Reporting

#### QA Story N1 - Vacation ledger supports post-vacation retrospective

As Hamel, I want to review what failed, what healed, and what still needs hardening when I return.

Acceptance criteria:
- query or report can show:
  - total incidents
  - self-healed incidents
  - unresolved incidents
  - top recurring failure classes
  - most-used remediation actions
- data comes from durable state, not scraped message history

Severity if failed: P2

---

### Section O - Negative and Boundary Cases

#### QA Story O1 - Enable fails cleanly when no current readiness run exists

As an operator, I want the system to refuse vacation activation if readiness was never run or is too old.

Acceptance criteria:
- clear failure message
- no partial state mutation

Severity if failed: P1

#### QA Story O2 - Duplicate enable is rejected safely

As an operator, I want only one active vacation window at a time.

Acceptance criteria:
- second enable attempt fails deterministically
- active row remains intact

Severity if failed: P1

#### QA Story O3 - Corrupted runtime mirror file does not override Postgres

As an operator, I want canonical Postgres state to win over stale or corrupted runtime cache files.

Acceptance criteria:
- corrupted mirror is ignored or rebuilt
- Postgres state remains authoritative

Severity if failed: P1

#### QA Story O4 - Summary job outside an active vacation window returns no output

As an operator, I want vacation summary jobs to stay quiet when vacation mode is inactive.

Acceptance criteria:
- summary command or cron returns `NO_REPLY`
- no Telegram message is sent

Severity if failed: P2

#### QA Story O5 - Auto-disable still restores paused jobs when resume summary delivery fails

As an operator, I want restore semantics to complete even if Telegram summary delivery fails so that state is correct even when notification is not.

Acceptance criteria:
- paused jobs are restored
- disable state is committed
- summary failure is logged separately

Severity if failed: P1

---

## Non-Functional Checks

### Performance

- readiness should complete within a bounded operator-friendly window under healthy conditions
- summaries should complete quickly enough for cron execution and should not carry large prompt/session weight

### Reliability

- repeated readiness runs should be idempotent unless manual-auth state changes
- vacation summary generation should not mutate readiness state except for run logging

### Security

- no interactive auth may be initiated autonomously during active vacation mode
- no new secrets may be introduced outside existing secret stores
- Postgres state must not leak secrets in ledger detail payloads

### Auditability

- every outcome, check, and remediation step must be reconstructable from durable state

---

## Suggested Execution Order

1. Run unit tests for config, threshold, and state transitions.
2. Run integration tests for Postgres persistence and CLI flows.
3. Run dry-run recommendation and prep on staging.
4. Run real Telegram preflight tests.
5. Run full readiness in production-like environment.
6. Enable a short synthetic vacation window and validate summaries, self-heal, and disable behavior.
7. Run post-window retrospective query validation.

---

## Sign-Off Checklist

The feature is ready for implementation-complete sign-off only when all are true:

- [ ] PRD approved
- [ ] Tech Spec approved
- [ ] QA Spec approved
- [ ] all P0 scenarios pass
- [ ] all P1 scenarios pass
- [ ] no stale-state false positive remains in tested recovery paths
- [ ] no active-vacation flow attempts autonomous interactive reauth
- [ ] `Daily Auto-Update` pause/restore is proven in live validation
- [ ] morning/evening summaries are readable on mobile
- [ ] at least one full rehearsal from prep to auto-disable passes on a production-like host
