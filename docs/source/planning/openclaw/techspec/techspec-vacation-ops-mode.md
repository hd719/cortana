# Technical Specification - Vacation Ops Mode and Readiness System

**Document Status:** Draft v1

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | Hamel |
| Epic | Vacation Ops Mode and Readiness System |

---

## Development Overview

This build adds a deterministic vacation operations layer on top of the existing `cortana` automation system.

After the change:

- Hamel can trigger pre-vacation prep manually or by natural-language request routed through a deterministic CLI.
- The system can recommend prep timing using travel calendar context, but cannot auto-enable vacation mode.
- One readiness command evaluates all vacation-critical systems and returns an authoritative `PASS`, `WARN`, `FAIL`, or `NO-GO` result.
- Vacation mode becomes an explicit, time-bounded operating state with a start time, end time, and canonical Postgres-backed state.
- While vacation mode is active, the system continues normal high-value automations (market, fitness, news, reminders, Morning Brief) but disables `Daily Auto-Update`.
- Automatic repair is limited to a deterministic, bounded ladder: retry, restart/reload, resync, env/plist restoration, stale session rotation, and exact smoke rerun.
- Morning and evening vacation summaries are sent to the `monitor` Telegram lane in a compact mobile-readable format.
- All failures, repair attempts, verification results, and unresolved degradations are written to a structured vacation ledger in Postgres.
- Vacation mode auto-disables at the configured end time, restores the paused auto-update job, and sends a `normal ops resumed` summary.

Locked product decisions for this build:

- Default morning and evening summary times are `08:00` and `20:00` in the configured local timezone until user customization exists.
- Backtester app health in v1 uses existing readiness and market-data surfaces plus the existing local app probe path; a dedicated endpoint is out of scope for v1.
- Vacation mode writes only to its own canonical vacation tables and incident ledger; autonomy taxonomy, system keys, and `incident_key` references are read-only compatibility references, not write targets.
- Mission Control and Tailscale are local-readiness and tailnet proxies only.
- Natural-language activation is an edge wrapper over deterministic CLI/state transitions only.

Affected repos and services:

- Primary repo: `cortana`
- Secondary repo surface: `cortana-external` for Mission Control health and market/backtester runtime checks
- Services touched by verification logic:
  - OpenClaw gateway
  - Telegram plugin and delivery paths
  - Mission Control (`http://127.0.0.1:3000/api/heartbeat-status`)
  - Tailscale CLI/daemon
  - `gog`
  - Apple Reminders monitor path
  - Morning Brief path
  - fitness service (`http://127.0.0.1:3033/tonal/health`, Whoop endpoints)
  - market-data / Schwab readiness (`/market-data/ready`, quote smoke)
  - browser CDP watchdog path

What must be deterministic and test-covered:

- tier classification
- go / no-go logic
- readiness decision ordering and terminal outcomes
- readiness result derivation
- vacation state transitions
- allowed remediation ladder and stop conditions
- daily summary schema
- summary payload and text template
- Postgres state persistence and recovery
- disabling and restoring `Daily Auto-Update`
- auto-disable on vacation end date
- clearing stale degraded state when fresh healthy evidence exists

What remains intentionally unchanged:

- existing business logic for Morning Brief, market scanning, fitness summaries, and reminders
- current Telegram plugin architecture
- current OpenClaw agent model routing and cron lane split
- existing dashboards such as Mission Control, except as consumers of the new vacation-state/ledger data later if desired

---

## Data Storage Changes

Describe database, file, cache, or state-shape changes.

### Database Changes

#### [NEW] `cortana_vacation_windows`

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| `PRIMARY KEY` | `id` | `BIGSERIAL` | canonical vacation window id |
| `NOT NULL` | `label` | `TEXT` | human label, default like `vacation-2026-04-20` |
| `NOT NULL` | `status` | `TEXT` | `prep`, `ready`, `active`, `completed`, `cancelled`, `expired`, `failed` |
| `NOT NULL` | `timezone` | `TEXT` | e.g. `America/New_York` |
| `NOT NULL` | `start_at` | `TIMESTAMPTZ` | intended vacation start |
| `NOT NULL` | `end_at` | `TIMESTAMPTZ` | auto-disable boundary |
| `NULL` | `prep_recommended_at` | `TIMESTAMPTZ` | travel-derived recommended prep time |
| `NULL` | `prep_started_at` | `TIMESTAMPTZ` | first prep run start |
| `NULL` | `prep_completed_at` | `TIMESTAMPTZ` | last successful prep completion |
| `NULL` | `enabled_at` | `TIMESTAMPTZ` | vacation mode activation time |
| `NULL` | `disabled_at` | `TIMESTAMPTZ` | explicit or auto-disable time |
| `NULL` | `disable_reason` | `TEXT` | `manual`, `expired`, `cancelled`, `failed_enable` |
| `NOT NULL DEFAULT 'manual'` | `trigger_source` | `TEXT` | `manual_command`, `natural_language`, `calendar_recommendation` |
| `NOT NULL DEFAULT 'hamel'` | `created_by` | `TEXT` | operator identity |
| `NOT NULL DEFAULT '{}'::jsonb` | `config_snapshot` | `JSONB` | snapshot of tiering, schedules, and remediation policy at activation |
| `NOT NULL DEFAULT '{}'::jsonb` | `state_snapshot` | `JSONB` | paused jobs, restored jobs, summary schedule, last known counters |
| `NOT NULL DEFAULT NOW()` | `created_at` | `TIMESTAMPTZ` | created timestamp |
| `NOT NULL DEFAULT NOW()` | `updated_at` | `TIMESTAMPTZ` | updated timestamp |

Notes:

- This is the canonical vacation-mode state store.
- Only one row may be `active` at a time; enforce with a partial unique index on `status='active'`.
- `config_snapshot` exists so historical vacation windows remain explainable even if repo config later changes.

---

#### [NEW] `cortana_vacation_runs`

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| `PRIMARY KEY` | `id` | `BIGSERIAL` | run id |
| `REFERENCES cortana_vacation_windows(id)` | `vacation_window_id` | `BIGINT` | nullable for pre-window recommendation runs |
| `NOT NULL` | `run_type` | `TEXT` | `recommend`, `prep`, `readiness`, `enable`, `disable`, `summary_morning`, `summary_evening`, `manual_recheck` |
| `NOT NULL` | `trigger_source` | `TEXT` | `manual_command`, `natural_language`, `cron`, `auto_expire` |
| `NOT NULL DEFAULT FALSE` | `dry_run` | `BOOLEAN` | dry-run flag |
| `NULL` | `readiness_outcome` | `TEXT` | `pass`, `warn`, `fail`, `no_go` when applicable |
| `NULL` | `summary_status` | `TEXT` | `green`, `yellow`, `red` when applicable |
| `NOT NULL DEFAULT '{}'::jsonb` | `summary_payload` | `JSONB` | machine-readable rollup for message generation |
| `NOT NULL DEFAULT ''` | `summary_text` | `TEXT` | exact compact text sent or intended to send |
| `NOT NULL DEFAULT NOW()` | `started_at` | `TIMESTAMPTZ` | start time |
| `NULL` | `completed_at` | `TIMESTAMPTZ` | completion time |
| `NOT NULL DEFAULT 'running'` | `state` | `TEXT` | `running`, `completed`, `failed`, `cancelled` |

Notes:

- One row per explicit vacation operation.
- `summary_payload` is the machine-readable source of truth; `summary_text` is derived output.
- `summary_payload` must be a stable JSON contract, not an unstructured blob.
- `summary_text` must be a short deterministic rendering of the payload, suitable for Telegram.
- This table provides historical operator auditability independent of Telegram message history.

---

#### [NEW] `cortana_vacation_check_results`

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| `PRIMARY KEY` | `id` | `BIGSERIAL` | result id |
| `REFERENCES cortana_vacation_runs(id) NOT NULL` | `run_id` | `BIGINT` | parent run |
| `NOT NULL` | `system_key` | `TEXT` | stable key such as `gateway`, `telegram_delivery`, `gog_headless_auth`, `mission_control`, `tailscale`, `schwab_quote_smoke` |
| `NOT NULL` | `tier` | `SMALLINT` | `0`, `1`, `2`, `3` |
| `NOT NULL` | `status` | `TEXT` | `green`, `yellow`, `red`, `info`, `warn`, `fail`, `skipped` |
| `NOT NULL` | `observed_at` | `TIMESTAMPTZ` | when the check result was produced |
| `NULL` | `freshness_at` | `TIMESTAMPTZ` | evidence timestamp used for freshness reasoning |
| `NOT NULL DEFAULT FALSE` | `remediation_attempted` | `BOOLEAN` | whether the run attempted repair |
| `NOT NULL DEFAULT FALSE` | `remediation_succeeded` | `BOOLEAN` | whether repair succeeded |
| `NULL` | `autonomy_incident_id` | `BIGINT` | optional read-only reference to `cortana_autonomy_incidents(id)` |
| `NULL` | `incident_key` | `TEXT` | optional stable autonomy incident key reference |
| `NOT NULL DEFAULT '{}'::jsonb` | `detail` | `JSONB` | raw evidence, thresholds, durations, command metadata, endpoint metadata |

Notes:

- `status` is intentionally normalized so the readiness runner can derive a consistent final result without parsing prose.
- `freshness_at` is mandatory for any result based on historical evidence rather than immediate probe output.
- A fresh healthy verification newer than a degraded result must clear stale degraded state in readiness aggregation.
- `freshness_at` is also used when updating `cortana_vacation_incidents` so the incident ledger resolves stale degradations deterministically.

---

#### [NEW] `cortana_vacation_actions`

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| `PRIMARY KEY` | `id` | `BIGSERIAL` | action id |
| `REFERENCES cortana_vacation_windows(id) NOT NULL` | `vacation_window_id` | `BIGINT` | parent window |
| `REFERENCES cortana_vacation_runs(id)` | `run_id` | `BIGINT` | originating run |
| `NULL` | `autonomy_incident_id` | `BIGINT` | optional read-only reference to an autonomy incident |
| `NULL` | `incident_key` | `TEXT` | optional stable incident key reference |
| `NOT NULL` | `system_key` | `TEXT` | same naming as check results |
| `NOT NULL` | `step_order` | `SMALLINT` | remediation ladder order |
| `NOT NULL` | `action_kind` | `TEXT` | `retry`, `restart_service`, `reload_launchd`, `runtime_sync`, `restore_env`, `rotate_session`, `rerun_smoke`, `alert_only` |
| `NOT NULL` | `action_status` | `TEXT` | `started`, `succeeded`, `failed`, `skipped`, `blocked` |
| `NULL` | `verification_status` | `TEXT` | `green`, `yellow`, `red`, `skipped` |
| `NOT NULL DEFAULT NOW()` | `started_at` | `TIMESTAMPTZ` | step start |
| `NULL` | `completed_at` | `TIMESTAMPTZ` | step end |
| `NOT NULL DEFAULT '{}'::jsonb` | `detail` | `JSONB` | command, launchd label, service name, endpoint, verification payload |

Notes:

- This is the repair ledger.
- It is intentionally separate from check results so a single degraded incident can record multiple attempted repair steps.
- This table supports the post-vacation retrospective and daily self-heal counts.

#### [NEW] `cortana_vacation_incidents`

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| `PRIMARY KEY` | `id` | `BIGSERIAL` | canonical incident id |
| `REFERENCES cortana_vacation_windows(id) NOT NULL` | `vacation_window_id` | `BIGINT` | parent window |
| `NULL` | `run_id` | `BIGINT` | most recent run that observed the incident |
| `NULL` | `latest_check_result_id` | `BIGINT` | pointer to the current evidence row |
| `NULL` | `latest_action_id` | `BIGINT` | pointer to the latest remediation action |
| `NOT NULL` | `system_key` | `TEXT` | stable component key |
| `NOT NULL` | `tier` | `SMALLINT` | `0`, `1`, `2`, or `3` |
| `NOT NULL` | `status` | `TEXT` | `open`, `degraded`, `human_required`, `resolved` |
| `NOT NULL DEFAULT FALSE` | `human_required` | `BOOLEAN` | whether Hamel intervention is needed |
| `NOT NULL` | `first_observed_at` | `TIMESTAMPTZ` | incident start |
| `NOT NULL` | `last_observed_at` | `TIMESTAMPTZ` | last time the condition was observed |
| `NULL` | `resolved_at` | `TIMESTAMPTZ` | incident close time |
| `NULL` | `resolution_reason` | `TEXT` | `healthy`, `manual`, `expired`, `remediated`, `acknowledged` |
| `NULL` | `symptom` | `TEXT` | short machine summary of what failed |
| `NOT NULL DEFAULT '{}'::jsonb` | `detail` | `JSONB` | evidence, thresholds, history, and operator notes |
| `NOT NULL DEFAULT NOW()` | `created_at` | `TIMESTAMPTZ` | creation time |
| `NOT NULL DEFAULT NOW()` | `updated_at` | `TIMESTAMPTZ` | update time |

Notes:

- This is the canonical vacation incident ledger and should be the source of truth for open, degraded, human-required, and resolved state.
- A check result may create or update an incident; a remediation action may update the same incident; a fresh healthy check must resolve the incident when the resolution rule is satisfied.
- The incident table exists specifically so the operator view and retrospective do not need to infer state by joining raw checks and actions ad hoc.

#### Readiness decision matrix

Readiness evaluation must be ordered and terminal:

1. Execute Tier 0 checks first.
2. If any Tier 0 check is red, return `NO-GO` immediately.
3. Execute Tier 1 checks and their bounded remediation ladder.
4. If any Tier 1 check remains red after remediation and verification, return `NO-GO`.
5. If readiness execution itself fails to complete or misses required evidence, return `FAIL`.
6. Execute Tier 2 checks.
7. If Tier 0 and Tier 1 are green and Tier 2 exceeds its configured thresholds, return `WARN`.
8. If Tier 0 and Tier 1 are green and Tier 2 remains within threshold, return `PASS`.

Fresh healthy evidence must supersede stale degraded evidence for the same `system_key` before the final result is emitted. The aggregator must not collapse live and stale evidence into one ambiguous status.

#### State transition ordering

Vacation state transitions must be explicit and atomic at the application level:

- `prep` creates or updates the canonical window in `prep` state and records any needed auth work
- `readiness` records the tiered results, remediation attempts, and final recommendation
- `enable` may proceed only after the latest readiness result is `PASS` or accepted `WARN`
- `enable` must write Postgres first, then write the runtime mirror, then disable `Daily Auto-Update`, then emit the activation summary
- `disable` may be manual or automatic
- `auto-expire` is the same disable flow triggered by the stored `end_at`
- `disable` must restore `Daily Auto-Update` before the resume summary is sent
- `disable` must clear or archive the runtime mirror after canonical Postgres state is updated
- repeated `disable` calls must be idempotent

If the process restarts after `end_at`, the next status or guard evaluation must detect the expired window from Postgres and complete disablement using the same transition path.

---

## Infrastructure Changes

### SNS Topic Changes

None.

### SQS Queue Changes

None.

### Cache Changes

Introduce one non-canonical runtime mirror file:

- `~/.openclaw/state/vacation-mode.json`

Purpose:

- fast local gating for cron scripts
- quick check for whether vacation mode is active
- local reference to active window id and end time
- quick lookup for paused/restored job ids

Shape:

- `vacationWindowId`
- `status`
- `startAt`
- `endAt`
- `timezone`
- `disabledJobIds`
- `summarySchedule`
- `updatedAt`

Rules:

- Postgres is canonical.
- The file is regenerated from Postgres during enable, disable, summary, and guard flows.
- If the file and Postgres disagree, Postgres wins and the file is rewritten.

### S3 Changes

None.

### Secrets Changes

No new secrets are required.

The implementation may read existing secrets and env state used by:

- OpenClaw gateway
- Telegram plugin
- `gog`
- Schwab and market-data runtime

But it must not introduce a second secret system.

### Network/Security Changes

- vacation-mode scripts will probe local and loopback endpoints such as Mission Control and fitness/market-data services
- Tailscale validation will require local CLI access via `tailscale status --json` and `tailscale ip -4`
- no new externally exposed ports are required
- no new auth providers are added
- no vacation-mode flow may perform autonomous interactive auth

---

## Behavior Changes

Describe how behavior changes for users, operators, jobs, or downstream systems.

- A new deterministic CLI becomes the source of truth for all vacation operations.
- Natural-language vacation requests must route into that CLI rather than directly mutating state.
- Readiness evaluation becomes tier-based and freshness-aware.
- `Daily Auto-Update` is disabled when vacation mode is enabled and restored when it ends.
- Market, fitness, news, Morning Brief, reminders, and normal high-value cron behavior continue during vacation mode.
- Morning and evening vacation summaries are sent to `monitor` with one compact message each.
- Actionable failures still alert immediately; summaries do not replace alerting.
- Any automatic repair performed while away is logged as an explicit remediation action and followed by verification.
- If an issue requires interactive reauth during vacation mode, the system must mark the component degraded, alert Hamel, and stop further auth mutation.

Safe degradation behavior:

- Tier 0 degradation -> red / `NO-GO` in prep; red alert during vacation
- Tier 1 degradation -> red / `NO-GO` if unresolved after allowed repair
- Tier 2 degradation -> `INFO` or `WARN` based on class-specific thresholds
- Tier 3 degradation -> logged and surfaced only in compact informational form unless explicitly escalated elsewhere
- fresh healthy verification newer than degraded evidence immediately clears stale degraded state

Tier 2 thresholds encoded in config:

- market / trading
  - `warn_after_minutes_market_hours = 30`
  - `warn_before_next_open_minutes = 60`
  - `warn_after_consecutive_failures = 2`
- fitness / news
  - `warn_after_consecutive_failures = 2`
  - `warn_after_stale_hours = 24`
- background intel / secondary enrichments
  - `warn_after_consecutive_failures = 2`
  - `warn_after_stale_hours = 12`

### Summary Contract

The vacation summary generator must emit a stable payload with these fields:

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

The Telegram text form must be a short deterministic render of that payload:

- first line: overall state and short operator label
- second line: one sentence describing the current situation
- third line: grouped component health
- fourth line: active issue or next action, if any

The generator must not emit raw JSON to the operator channel except under explicit `--json` mode. If a field is absent, it should be rendered as `unknown` or omitted, never guessed.

---

## Application/Script Changes

List new and updated files with exact paths.

New files:

- `/Users/hd/Developer/cortana/config/vacation-ops.json`
  - typed config for system tiers, thresholds, schedules, remediation ladder, and paused job ids
- `/Users/hd/Developer/cortana/migrations/004_vacation_ops_mode.sql`
  - creates vacation mode tables and indexes
- `/Users/hd/Developer/cortana/tools/vacation/vacation-ops.ts`
  - single deterministic CLI entrypoint with subcommands: `recommend`, `prep`, `readiness`, `enable`, `disable`, `summary`, `status`
- `/Users/hd/Developer/cortana/tools/vacation/vacation-checks.ts`
  - typed check registry and check execution engine for Tier 0/1/2/3 systems
- `/Users/hd/Developer/cortana/tools/vacation/vacation-remediation.ts`
  - deterministic remediation ladder, stop conditions, and verification chaining
- `/Users/hd/Developer/cortana/tools/vacation/vacation-state.ts`
  - Postgres reads/writes and runtime mirror file sync
- `/Users/hd/Developer/cortana/tools/vacation/vacation-summary.ts`
  - compact morning/evening summary builder and sender
- `/Users/hd/Developer/cortana/tools/vacation/vacation-calendar-recommendation.ts`
  - reads calendar context and recommends prep timing without mutating state
- `/Users/hd/Developer/cortana/tests/vacation/vacation-ops.test.ts`
  - CLI and state-transition tests
- `/Users/hd/Developer/cortana/tests/vacation/vacation-thresholds.test.ts`
  - class-specific threshold and freshness logic tests
- `/Users/hd/Developer/cortana/tests/vacation/vacation-remediation.test.ts`
  - remediation ladder tests
- `/Users/hd/Developer/cortana/tests/vacation/vacation-summary.test.ts`
  - summary payload/text contract tests

Updated files:

- `/Users/hd/Developer/cortana/config/cron/jobs.json`
  - add morning/evening vacation summary jobs and auto-disable guard wiring
  - keep `🏖️ Vacation Mode Fragile Guard (15m)` but make it DB-aware
  - mark `🔄 Daily Auto-Update (notify Hamel)` as vacation-pausable using its stable job id `af9e1570-3ba2-4d10-a807-91cdfc2df18b`
- `/Users/hd/Developer/cortana/tools/monitoring/vacation-mode-guard.ts`
  - read canonical Postgres-backed state via the new state layer instead of acting as the primary state source
- `/Users/hd/Developer/cortana/tools/qa/green-baseline.sh`
  - optionally expose vacation-aware output metadata or reuseable check wrappers, without changing current human-facing baseline semantics
- `/Users/hd/Developer/cortana/tools/openclaw/runtime-integrity-check.ts`
  - export or share reusable deterministic check helpers where appropriate
- `/Users/hd/Developer/cortana/docs/source/planning/openclaw/prd/prd-vacation-ops-mode.md`
  - keep PRD and Tech Spec linked and aligned

If multiple repos are involved, split the section by repo.

Secondary repo checks only, no primary implementation in phase 1:

- `/Users/hd/Developer/cortana-external/apps/mission-control`
  - consume existing health endpoint `/api/heartbeat-status`
- `/Users/hd/Developer/cortana-external/watchdog/watchdog.sh`
  - may be referenced as evidence for existing health surfaces, but the vacation core remains in `cortana`
- `/Users/hd/Developer/cortana-external/backtester`
  - existing readiness artifacts and market-data health surfaces may be consumed by vacation checks

LLM-agnostic implementation rule:

- no essential rule should exist only in prose
- thresholds and mappings should live in typed constants or stable schemas
- uncertain data should degrade confidence instead of being guessed away
- natural-language activation must only route into deterministic subcommands and typed arguments

---

## API Changes

Document endpoint or interface changes.

### [NEW] `vacation-ops` CLI interface

| Field | Value |
|-------|-------|
| **API** | `CLI: npx tsx /Users/hd/Developer/cortana/tools/vacation/vacation-ops.ts <subcommand>` |
| **Description** | Canonical entrypoint for vacation recommendation, prep, readiness, enable/disable, summaries, and status queries. |
| **Additional Notes** | This is the only supported mutation path for vacation mode state. Natural-language handling must delegate to this interface. |

| Field | Detail |
|-------|--------|
| **Authentication** | local machine user context; relies on existing local service auth |
| **URL Params** | none |
| **Request** | subcommands such as `recommend`, `prep`, `readiness`, `enable`, `disable`, `summary`, `status` with typed flags for `--start`, `--end`, `--timezone`, `--json`, `--window-id`, `--period` |
| **Success Response** | machine-readable JSON on `--json`; compact human-readable summary otherwise |
| **Error Responses** | explicit failure categories such as `NO_GO`, `CHECK_FAILED`, `AUTH_REQUIRED`, `VACATION_NOT_ACTIVE`, `VACATION_ALREADY_ACTIVE`, `INVALID_WINDOW`, `AUTO_DISABLE_FAILED` |

Example subcommands to support:

- `recommend --json`
- `prep --start <ts> --end <ts> --json`
- `readiness --window-id <id> --json`
- `enable --window-id <id> --json`
- `disable --window-id <id> --reason manual --json`
- `summary --window-id <id> --period morning --json`
- `status --json`

No new external HTTP API is required in phase 1.

---

## Process Changes

Call out workflow, cron, operator, or rollout changes.

- Hamel triggers vacation prep manually or via natural language routed to `vacation-ops.ts`.
- The system may recommend prep timing from travel calendar context, but cannot auto-enable vacation mode.
- Prep may request explicit human approval for interactive auth refresh where required.
- A readiness run must happen before enable.
- `enable` writes canonical Postgres state, writes the runtime mirror file, disables `Daily Auto-Update`, and emits one activation summary.
- Morning and evening cron jobs call `vacation-ops.ts summary --period morning|evening`; if vacation mode is inactive they return `NO_REPLY`.
- The existing vacation fragile guard continues running, but reads canonical state and only quarantines configured fragile jobs when policy requires it.
- `disable` or auto-expire restores paused jobs, clears or archives the runtime mirror, records the closeout in Postgres, and sends `normal ops resumed`.
- The retrospective can query vacation runs, check results, and actions directly from Postgres after Hamel returns.

Default summary schedule until user customization exists:

- `08:00` local timezone for morning summary
- `20:00` local timezone for evening summary

These defaults should live in `config/vacation-ops.json` and remain overrideable.

---

## Test Plan

Name the verification surface directly.

Unit and integration coverage:

- `/Users/hd/Developer/cortana/tests/vacation/vacation-ops.test.ts`
- `/Users/hd/Developer/cortana/tests/vacation/vacation-thresholds.test.ts`
- `/Users/hd/Developer/cortana/tests/vacation/vacation-remediation.test.ts`
- `/Users/hd/Developer/cortana/tests/vacation/vacation-summary.test.ts`
- `/Users/hd/Developer/cortana/tests/openclaw/runtime-integrity-check.test.ts` (where shared check helpers are extracted)
- `/Users/hd/Developer/cortana/tests/monitoring/vacation-mode-guard.test.ts` or equivalent updated coverage

Manual or live validation:

- trigger `recommend` with travel calendar entries present and confirm prep recommendation is advisory only
- run `prep` and confirm real Telegram preflight test messages arrive in `monitor`
- confirm `main` and `monitor` agent delivery tests pass
- confirm Mission Control health check passes via `http://127.0.0.1:3000/api/heartbeat-status`
- confirm Tailscale health check passes via `tailscale status --json`
- confirm Gog headless auth, calendar reminder helper, and Apple Reminders wrapper pass
- confirm Morning Brief path passes
- confirm fitness service health passes
- confirm Schwab / market-data readiness and quote smoke pass
- enable vacation mode and verify `Daily Auto-Update` is disabled by stable job id
- trigger morning and evening summary jobs while active and confirm compact `monitor` messages arrive
- simulate an allowed self-heal path and confirm `cortana_vacation_actions` rows are written
- simulate auto-disable at end time and confirm `normal ops resumed` is sent and paused jobs are restored

Success means:

- readiness returns the correct go / no-go state for staged healthy and unhealthy scenarios
- every allowed remediation step is logged and verified
- no interactive reauth is attempted during active vacation mode
- stale degraded evidence clears when a newer healthy verification exists
- summary text stays compact and mobile-readable
- `Daily Auto-Update` is always restored when vacation mode exits

---

## Operational Assumptions

- Mission Control and Tailscale are accepted as local-readiness and tailnet proxies only; they are not treated as proof of Internet-wide reachability from a remote island.
- Backtester app health in v1 relies on existing readiness and market-data artifacts plus the existing local app probe path; a dedicated endpoint is not part of this build.
- Natural-language activation remains LLM-mediated at the edge; the implementation must ensure the edge can only call deterministic CLI/state transitions and cannot bypass them.
