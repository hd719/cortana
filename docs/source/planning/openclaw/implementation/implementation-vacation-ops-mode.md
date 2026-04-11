# Implementation Plan - Vacation Ops Mode and Readiness System

**Document Status:** Draft v1

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | Hamel |
| Epic | Vacation Ops Mode and Readiness System |
| Tech Spec | [Vacation Ops Tech Spec](../techspec/techspec-vacation-ops-mode.md) |
| PRD | [Vacation Ops PRD](../prd/prd-vacation-ops-mode.md) |
| QA Spec | [Vacation Ops QA Spec](../qa/qa-spec-vacation-ops-mode.md) |

---

## Dependency Map

| Vertical | Dependencies | Can Start? |
|----------|-------------|------------|
| V1 - Schema and Config Foundation | None | Start Now |
| V2 - Canonical State and CLI Skeleton | V1 | Start after V1 |
| V3 - Check Registry and Readiness Engine | V1, V2 | Start after V1, V2 |
| V4 - Deterministic Remediation and Ledger | V1, V2, V3 | Start after V1, V2, V3 |
| V5 - Vacation Mode Enable / Disable State Machine | V1, V2, V3, V4 | Start after V1-V4 |
| V6 - Summary Delivery and Cron Wiring | V2, V3, V5 | Start after V2, V3, V5 |
| V7 - End-to-End Rehearsal and Hardening | V1-V6 | Start after V1-V6 |

---

## Recommended Execution Order

```text
Week 1: V1 + V2
Week 2: V3
Week 3: V4 + V5
Week 4: V6
Week 5: V7
```

If multiple agents are used:

- one agent can own V1 + V2
- one agent can own V3
- one agent can own V4 after V3 contracts settle
- one agent can own V6 after V5 state semantics settle
- V7 should stay with the orchestrator or a designated integrator because it spans real runtime validation

---

## Sprint 1 - Establish Canonical State and Contracts

### Vertical 1 - Schema and Config Foundation

**cortana: Create canonical vacation-mode schema, typed config, and stable identifiers before any orchestration logic is written**

*Dependencies: None*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana/migrations/004_vacation_ops_mode.sql`.
  - Add `cortana_vacation_windows`.
  - Add `cortana_vacation_runs`.
  - Add `cortana_vacation_check_results`.
  - Add `cortana_vacation_incidents` as the canonical incident ledger.
  - Add `cortana_vacation_actions`.
  - Add indexes for active window uniqueness, run lookup, check lookup by system/tier, incident lookup by system/window/state, and action lookup by incident and window.
- Sub-task 2: Create `/Users/hd/Developer/cortana/config/vacation-ops.json`.
  - Encode Tier 0 / Tier 1 / Tier 2 / Tier 3 system keys.
  - Encode Tier 2 class-based thresholds.
  - Encode allowed remediation ladder.
  - Encode default summary times.
  - Encode the readiness freshness gate used by `enable` so stale readiness runs are rejected instead of reused.
  - Default the authorization freshness window to `6h` unless config explicitly overrides it.
  - Encode paused job ids including `af9e1570-3ba2-4d10-a807-91cdfc2df18b` for `Daily Auto-Update`.
- Sub-task 3: Create `/Users/hd/Developer/cortana/tools/vacation/types.ts`.
  - Centralize shared TypeScript types for window state, run type, check result, action row, and summary payloads.
- Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/vacation/vacation-config.test.ts` and `/Users/hd/Developer/cortana/tests/vacation/vacation-schema.test.ts`.

#### Important Planning Notes

- Do not let thresholds live only in code comments or prose.
- Use stable `system_key` values from day one; avoid later renames that would fragment history.
- The migration must be additive and safe against repeated execution.
- Postgres is canonical. No runtime file may be treated as a source of truth.
- The incident ledger must be first-class, not inferred from check rows after the fact.

#### Testing

- Migration runs idempotently.
- `config/vacation-ops.json` parses cleanly and matches expected types.
- Partial unique index prevents more than one active vacation window.
- Stable job ids and system keys can be loaded without fallback string guessing.

---

### Vertical 2 - Canonical State and CLI Skeleton

**cortana: Build a single deterministic `vacation-ops` entrypoint and canonical state layer before implementing behavior-specific checks**

*Dependencies: Depends on V1*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana/tools/vacation/vacation-state.ts`.
  - Read/write vacation windows and runs.
  - Read/write check rows and action rows.
  - Read active window from Postgres.
  - Generate and reconcile `~/.openclaw/state/vacation-mode.json` as a mirror only.
- Sub-task 2: Create `/Users/hd/Developer/cortana/tools/vacation/vacation-ops.ts`.
  - Add subcommands: `recommend`, `prep`, `readiness`, `enable`, `disable`, `summary`, `status`.
  - Support `--json`, `--window-id`, `--start`, `--end`, `--timezone`, `--period`, `--reason`.
  - `enable` must reject stale readiness results even if they were previously healthy.
- Sub-task 3: Add a small command-dispatch contract test in `/Users/hd/Developer/cortana/tests/vacation/vacation-ops.test.ts`.
- Sub-task 4: Add runtime mirror reconciliation tests in `/Users/hd/Developer/cortana/tests/vacation/vacation-state.test.ts`.

#### Important Planning Notes

- The CLI must be the only supported mutation path for vacation state.
- Natural-language integrations later must call into this CLI/state layer, not duplicate logic.
- `status` should be safe and read-only.
- `disable` must support both `manual` and `expired` reasons.

#### Testing

- CLI subcommand parsing is stable.
- Active window state reads correctly from Postgres.
- Corrupted runtime mirror files are ignored and rebuilt from Postgres.
- No subcommand mutates state unless it is explicitly a mutating path.

---

## Sprint 2 - Make Readiness Real

### Vertical 3 - Check Registry and Readiness Engine

**cortana: Implement deterministic system checks, tier handling, and final go / no-go scoring**

*Dependencies: Depends on V1, V2*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana/tools/vacation/vacation-checks.ts`.
  - Register all system checks with stable keys.
  - Map each system to its tier.
  - Define immediate probe, historical evidence, freshness source, and remediation capability metadata.
- Sub-task 2: Create `/Users/hd/Developer/cortana/tools/vacation/readiness-engine.ts`.
  - Run checks.
  - Apply freshness rules.
  - Apply Tier 2 class-specific thresholds.
  - Derive `PASS`, `WARN`, `FAIL`, `NO-GO`.
  - Preserve the freshest result per system and reject stale ready-to-enable state when a newer run supersedes it.
- Sub-task 3: Reuse deterministic existing checks where possible rather than rewriting everything.
  - `green-baseline.sh`
  - `critical-synthetic-probe.ts`
  - `runtime-integrity-check.ts`
  - reminder/gog helpers
  - browser CDP watchdog script path
- Sub-task 4: Add system-specific test coverage in:
  - `/Users/hd/Developer/cortana/tests/vacation/vacation-readiness.test.ts`
  - `/Users/hd/Developer/cortana/tests/vacation/vacation-thresholds.test.ts`
  - `/Users/hd/Developer/cortana/tests/vacation/vacation-freshness.test.ts`

#### Required system keys

Tier 0:
- `gateway_service`
- `telegram_delivery`
- `main_agent_delivery`
- `monitor_agent_delivery`
- `mission_control`
- `tailscale_remote_access`
- `runtime_integrity`
- `green_baseline`
- `critical_synthetic_probe`

Tier 1:
- `gog_headless_auth`
- `calendar_reminders_e2e`
- `apple_reminders_e2e`
- `morning_brief_e2e`
- `gmail_inbox_triage`
- `fitness_service`
- `schwab_quote_smoke`
- `backtester_app`
- `github_identity`
- `browser_cdp`

#### Important Planning Notes

- Freshness-aware scoring is mandatory. A newer healthy verification must suppress older degraded state.
- A stale readiness result cannot be reused for activation if its freshness window has expired or if a newer run exists.
- Do not parse human-oriented message text if a deterministic signal already exists.
- The readiness engine must emit machine-readable reasoning for every final decision.
- `FAIL` should mean the readiness run itself was incomplete or inconclusive, not just that a system is red.

#### Testing

- Tier 0 failure always returns `NO-GO`.
- Resolved Tier 1 issue does not remain `NO-GO`.
- Tier 2 thresholds differ correctly by class.
- Newer healthy evidence clears older degraded state.
- Missing required checks produce `FAIL`, not false `PASS`.

---

## Sprint 3 - Bounded Self-Heal and State Transitions

### Vertical 4 - Deterministic Remediation and Ledger

**cortana: Implement the allowed repair ladder and durable remediation logging without crossing into open-ended repair behavior**

*Dependencies: Depends on V1, V2, V3*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana/tools/vacation/vacation-remediation.ts`.
  - Encode the allowed ladder:
    1. retry
    2. restart/reload
    3. runtime sync
    4. env/plist restoration
    5. stale session rotation
    6. rerun exact smoke
- Sub-task 2: Integrate remediation results into `cortana_vacation_actions`.
  - Link repairs back to `cortana_vacation_incidents` so one incident can carry many repair attempts without losing identity.
- Sub-task 3: Connect remediation to existing deterministic utilities where they already exist.
  - runtime sync script
  - gateway env/plist reconciliation
  - launchctl kickstart/reload wrappers
  - session hygiene / rotation utilities
- Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/vacation/vacation-remediation.test.ts`.

#### Important Planning Notes

- The ladder must stop when verification succeeds.
- The ladder must stop and alert when exhausted.
- No interactive reauth while vacation mode is active.
- Any “deeper investigation” path must be logged distinctly and must not be the default repair path.

#### Testing

- Repairs execute in the allowed order only.
- Successful repair halts the ladder.
- Exhausted ladder produces unresolved failure and alert state.
- Interactive-auth-required cases are marked human-required and do not attempt autonomous reauth.

---

### Vertical 5 - Vacation Mode Enable / Disable State Machine

**cortana: Make vacation mode a real state machine with safe activation, auto-disable, and restore behavior**

*Dependencies: Depends on V1, V2, V3, V4*

#### Jira

- Sub-task 1: Implement `enable` in `/Users/hd/Developer/cortana/tools/vacation/vacation-ops.ts`.
  - Require a current acceptable readiness result that is both in the allowed state and inside the configured freshness window.
  - Create/update the active window row.
  - Write runtime mirror state.
  - Disable `Daily Auto-Update` by stable job id `af9e1570-3ba2-4d10-a807-91cdfc2df18b`.
- Sub-task 2: Implement `disable` and `auto-expire` paths.
  - Restore paused jobs.
  - Update canonical state.
  - Clear or archive runtime mirror.
  - Send `normal ops resumed` summary.
- Sub-task 3: Define the exact state-transition ordering for `enable`, `disable`, and `auto-expire`.
  - `enable` order: verify freshness gate, lock/create active window, persist canonical state, write runtime mirror, pause `Daily Auto-Update`, emit activation summary, release lock.
  - `disable` order: mark window closing, restore paused jobs, persist terminal state, clear or archive runtime mirror, emit resume summary, release lock.
  - `auto-expire` order: mark expired, restore paused jobs, persist terminal state, clear or archive runtime mirror, emit `normal ops resumed`, release lock.
  - If summary delivery fails, the state transition and restore steps still complete.
- Sub-task 4: Update `/Users/hd/Developer/cortana/tools/monitoring/vacation-mode-guard.ts` to read canonical state and behave as a policy enforcer, not the system of record.
- Sub-task 5: Add tests in `/Users/hd/Developer/cortana/tests/vacation/vacation-state-machine.test.ts`.

#### Important Planning Notes

- Auto-disable must be idempotent.
- Restore actions must occur even if summary delivery fails.
- If pause/restore of `Daily Auto-Update` fails, the failure must be explicit and logged.
- There must never be more than one active vacation window.
- `enable` must never succeed from a stale readiness result, even if the underlying checks were once healthy.
- The default enable freshness window is `6h`; older readiness results are rejected even if they were once healthy.

#### Testing

- `enable` fails when readiness is `NO-GO` or `FAIL`.
- `enable` succeeds when readiness is `PASS` or allowed `WARN`.
- `enable` fails when the most recent readiness result is older than the configured freshness window.
- `enable` fails when the most recent readiness result is older than `6h` by default.
- `Daily Auto-Update` pauses on enable and restores on disable.
- Auto-expire restores state and emits `normal ops resumed` once.
- Duplicate enable attempts fail safely.

---

## Sprint 4 - Operator Output and Runtime Wiring

### Vertical 6 - Summary Delivery and Cron Wiring

**cortana: Add morning/evening vacation summaries and wire runtime jobs to the canonical state model**

*Dependencies: Depends on V2, V3, V5*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana/tools/vacation/vacation-summary.ts`.
  - Build compact `monitor` summaries.
  - Include overall state, grouped subsystem rollup, self-heal count, human-required count, and one-line degradation text.
  - Emit a strict summary payload contract that the text renderer consumes without extra inference.
  - The payload must at minimum carry `window_id`, `period`, `overall_status`, `readiness_outcome`, `active_incident_count`, `resolved_incident_count`, `human_required_count`, `paused_job_ids`, `last_transition_at`, and `latest_readiness_run_id`.
  - The text renderer must never infer status from freeform prose when a structured field exists.
- Sub-task 2: Update `/Users/hd/Developer/cortana/config/cron/jobs.json`.
  - Add or wire morning summary cron.
  - Add or wire evening summary cron.
  - Ensure both return `NO_REPLY` when vacation mode is inactive.
  - Keep `🏖️ Vacation Mode Fragile Guard (15m)` active and DB-aware.
- Sub-task 3: Add summary tests in `/Users/hd/Developer/cortana/tests/vacation/vacation-summary.test.ts` and cron contract tests in `/Users/hd/Developer/cortana/tests/cron/vacation-cron-contract.test.ts`.
- Sub-task 4: Add Telegram delivery live-validation hooks or fixtures for summary send behavior.

#### Important Planning Notes

- Summary text must remain one short message.
- Summaries must not become giant heartbeat essays.
- Vacation alerts and summaries are separate products; do not merge them.
- Summary generation must not mutate readiness state except for run logging.
- The summary payload is canonical; summary text is a deterministic rendering of that payload.
- Summary content must reflect the current incident ledger, not just the last check result.

#### Testing

- Summary job returns `NO_REPLY` when vacation mode is inactive.
- Morning and evening summaries route to `monitor` only.
- Summary text is compact and stable.
- Recovered incidents do not remain in summary rollups once newer healthy evidence exists.
- Summary output rejects stale readiness-backed state if a newer run has superseded it.

---

## Sprint 5 - Full-System Rehearsal and Hardening

### Vertical 7 - End-to-End Rehearsal and Hardening

**cortana + cortana-external: prove the system on real runtime surfaces before declaring it vacation-safe**

*Dependencies: Depends on V1-V6*

#### Jira

- Sub-task 1: Execute staging and production-like rehearsal using the QA spec.
  - run `recommend`
  - run `prep`
  - run readiness
  - enable a short synthetic vacation window
  - validate morning/evening summaries
  - simulate at least one allowed self-heal
  - validate auto-disable and restore
- Sub-task 2: Validate Mission Control and Tailscale checks against real local and remote-ready surfaces.
- Sub-task 3: Validate backtester/market-data checks against existing readiness surfaces and watchlist usage needs.
- Sub-task 4: Patch any deterministic gaps discovered during rehearsal without expanding scope into unrelated feature work.

#### Important Planning Notes

- This is the stage where wording problems, stale-state leaks, and operator-noise issues will show up.
- Do not treat green unit tests as sufficient. This system is inherently operational.
- If a check cannot be validated end to end in a production-like environment, it should not count as trusted vacation-critical coverage.

#### Testing

- Full QA-spec P0 and P1 scenarios pass.
- Real Telegram preflight test messages arrive.
- Real `monitor` vacation summary messages arrive.
- At least one real bounded self-heal is observed and logged correctly.
- Auto-disable restores paused jobs and sends resume summary.

---

## Dependency Notes

### V1 before V2

Canonical schema and config must exist before the CLI/state layer can be implemented safely. Otherwise the CLI will bake unstable assumptions into code.

### V2 before V3

The readiness engine needs a canonical run model and state layer so that check results and final outcomes can be persisted consistently.

### V3 before V4

Remediation policy must operate on stable system keys and verified check results. Otherwise repair logic will be tightly coupled to ad hoc probe behavior.

### V4 before V5

Vacation enable/disable behavior depends on knowing how unresolved failures are represented and how repairs are logged. The state machine should not be implemented first.

### V5 before V6

Summaries and cron wiring depend on an actual active/inactive vacation state and on the ability to distinguish active alerts from rolled-up status.

### V6 before V7

The rehearsal phase must exercise the real operator-facing output, not just the internal readiness engine.

---

## Scope Boundaries

### In Scope (This Plan)

- canonical Postgres-backed vacation state
- deterministic readiness scoring
- bounded remediation ladder
- vacation mode enable / disable / expire semantics
- pause/restore of `Daily Auto-Update`
- compact morning/evening summaries
- DB-backed incident / repair ledger for vacation window activity
- production-like rehearsal and validation

### External Dependencies

- OpenClaw gateway runtime and plugin health
- Telegram delivery path
- Gog auth store and helper paths
- Tailscale CLI / daemon
- Mission Control health endpoint in `cortana-external`
- market-data / Schwab readiness surfaces in `cortana-external`
- fitness service health surfaces
- Postgres availability

### Integration Points

- `~/.openclaw/cron/jobs.json`
- `~/.openclaw/state/vacation-mode.json`
- `cortana_vacation_incidents`
- Mission Control at `http://127.0.0.1:3000/api/heartbeat-status`
- Tailscale via `tailscale status --json`
- runtime integrity / green baseline / synthetic probe / reminders / morning brief / market-data smoke helpers

---

## Realistic Delivery Notes

This project is operationally sensitive. The main risk is not writing the code; it is building something that appears complete but lies under real unattended conditions.

The smallest credible delivery order is:

1. schema and config
2. canonical state + CLI
3. readiness engine
4. remediation ladder
5. enable/disable semantics
6. summary and cron wiring
7. production-like rehearsal

Do not invert that order.

- **Biggest risks:** stale-state false positives, summary noise, hidden interactive-auth dependencies, and pause/restore drift on `Daily Auto-Update`.
- **Assumptions:** Postgres remains available, existing check helpers are stable enough to reuse, and Mission Control / market-data surfaces in `cortana-external` stay compatible with the checks defined in `cortana`.
