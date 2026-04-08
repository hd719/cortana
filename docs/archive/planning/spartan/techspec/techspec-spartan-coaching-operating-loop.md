# Technical Specification - Spartan Coaching Operating Loop

**Document Status:** Implemented

Shipped on `main`; retained as the technical reference for the current system.

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | @hd |
| Epic | Spartan Coaching Operating Loop |

---

## Development Overview

Turn the current cron messages into a closed-loop coaching system in `cortana` by adding a daily mission artifact, structured check-in ingestion, post-workout note parsing, alert policies, compliance tracking, and weekly/monthly outcome evaluation that all read from the canonical athlete state and training recommendation layers. Keep the communication surface concise in Telegram, preserve Spartan's existing identity and cadence, and encode message contracts, alert thresholds, and evaluation rules in deterministic code and cron tests so the loop remains LLM agnostic and operationally reliable.

---

## Data Storage Changes

### Database Changes

#### [NEW] public.coach_checkin_log

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK, NOT NULL | id | UUID | Default `gen_random_uuid()`. |
| UNIQUE | source_key | TEXT | Stable dedupe key from inbound message parse. |
| NOT NULL | ts_utc | TIMESTAMPTZ | Check-in time. |
| NOT NULL | date_local | DATE | Local coaching date. |
| NOT NULL | checkin_type | TEXT | `midday`, `post_workout`, `evening`, `ad_hoc`. |
|  | compliance_status | TEXT | `completed`, `missed`, `pending`, `unknown`. |
|  | soreness_score | NUMERIC(4,2) | Optional 0-10 style mapped score. |
|  | pain_flag | BOOLEAN | True if pain or injury language is detected. |
|  | motivation_score | NUMERIC(4,2) | Optional parsed motivation indicator. |
|  | schedule_constraint | TEXT | Parsed note such as short session or travel. |
| NOT NULL | raw_text | TEXT | Original user text excerpt. |
| NOT NULL, DEFAULT `'{}'::jsonb` | parsed | JSONB | Parsed entities and confidence. |
| NOT NULL | created_at | TIMESTAMPTZ | Creation timestamp. |

#### [NEW] public.coach_alert_log

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK, NOT NULL | id | UUID | Default `gen_random_uuid()`. |
| UNIQUE | alert_key | TEXT | Stable dedupe key. |
| NOT NULL | ts_utc | TIMESTAMPTZ | Alert creation time. |
| NOT NULL | alert_type | TEXT | `freshness`, `recovery_risk`, `overreach`, `protein_miss`, `pain`, `schedule_conflict`, and similar. |
| NOT NULL | severity | TEXT | `info`, `warning`, `high`. |
| NOT NULL | delivered | BOOLEAN | Whether the alert was sent. |
|  | delivered_at | TIMESTAMPTZ | Delivery time if sent. |
| NOT NULL, DEFAULT `'{}'::jsonb` | context | JSONB | Structured source values and rationale. |
| NOT NULL | created_at | TIMESTAMPTZ | Creation timestamp. |

#### [NEW] public.coach_outcome_eval_weekly

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK, NOT NULL | iso_week | TEXT | Weekly key. |
| NOT NULL | week_start | DATE | Week start. |
| NOT NULL | week_end | DATE | Week end. |
| NOT NULL | overall_score | INT | `0-100` outcome alignment score. |
|  | adherence_score | INT | Recommendation follow-through. |
|  | recovery_alignment_score | INT | Whether load matched recovery quality. |
|  | nutrition_alignment_score | INT | Whether fueling matched training demand. |
|  | risk_management_score | INT | Whether avoidable risk days were limited. |
|  | performance_alignment_score | INT | Whether productive training outputs improved or held. |
| NOT NULL, DEFAULT `'{}'::jsonb` | explanation | JSONB | Short explanation fields and key wins/failures. |
| NOT NULL, DEFAULT `'{}'::jsonb` | evidence | JSONB | Linked decisions, athlete-state rows, and check-ins. |
| NOT NULL | created_at | TIMESTAMPTZ | Creation timestamp. |
| NOT NULL | updated_at | TIMESTAMPTZ | Update timestamp. |

#### [UPDATE] public.coach_decision_log

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| Existing | ts_utc | TIMESTAMPTZ | Keep timestamp. |
|  | source_state_date | DATE | Link to athlete-state row. |
|  | source_iso_week | TEXT | Link to weekly recommendation if applicable. |
|  | expected_followup_by | TIMESTAMPTZ | Expected next check-in or compliance horizon. |
|  | decision_key | TEXT | Stable dedupe or linkage key. |
| NOT NULL, DEFAULT `'{}'::jsonb` | payload | JSONB | Structured action contract and rationale. |

#### [UPDATE] public.coach_conversation_log

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| Existing | source_key | TEXT | Keep unique. |
|  | linked_state_date | DATE | Optional link to athlete-state date. |
|  | linked_decision_key | TEXT | Optional link to most relevant decision. |
| NOT NULL, DEFAULT `'{}'::jsonb` | parsed_entities | JSONB | Parsed check-in or note entities. |

---

## Infrastructure Changes (if any?)

### SNS Topic Changes

None.

### SQS Queue Changes

None.

### Cache Changes

None.

### S3 Changes

None.

### Secrets Changes

None.

### Network/Security Changes

None.

---

## Behavior Changes

- Morning coaching gains a stable `today mission` contract.
- User updates become actionable state changes instead of only raw chat history.
- Alerts are unified under one policy framework and logged for later audit.
- Compliance becomes structured:
  - recommendation completed
  - missed
  - deferred
  - contradicted by later input
- Weekly outputs gain outcome evaluation:
  - how well Spartan’s guidance aligned with actual behavior and outcomes

Failure behavior:

- If parsing confidence is low, the system stores the raw note and flags it as low-confidence instead of pretending the parse is correct.
- If alert inputs are stale or weak, severity should stay conservative and avoid noisy false positives.

---

## Application/Script Changes

New files in `cortana`:

- `tools/fitness/checkin-db.ts`
  - schema helpers for check-ins, alerts, and weekly outcome evaluation
- `tools/fitness/today-mission-data.ts`
  - build one structured daily mission artifact
- `tools/fitness/post-workout-note-parser.ts`
  - parse training completion, soreness, pain, and schedule context from natural-language updates
- `tools/fitness/alert-policy.ts`
  - deterministic alert rules and dedupe helpers
- `tools/fitness/outcome-eval.ts`
  - compute weekly and monthly coaching outcome scores

Updated files in `cortana`:

- `tools/fitness/coach-conversation-sync.ts`
  - route parsed check-ins into the new tables and linkage fields
- `tools/fitness/morning-brief-data.ts`
  - optionally build and persist today mission before rendering the brief
- `tools/fitness/evening-recap-data.ts`
  - write end-of-day closure inputs for compliance and evaluation
- `tools/fitness/weekly-insights-data.ts`
  - incorporate the new weekly outcome evaluation
- `tools/fitness/coach-db.ts`
  - add decision and conversation linkage fields if kept in the same module
- `tools/fitness/specialist-prompts.md`
  - align deeper analyses to the new structured artifacts
- `identities/spartan/MEMORY.md`
  - update stable memory rules only if needed after the new loop is in place

Potential cron/config updates:

- `~/.openclaw/cron/jobs.json`
  - keep existing morning, evening, weekly, monthly jobs
  - add or formalize a midday mission/check-in job if needed
  - add or refactor alert jobs to use one alert-policy layer rather than one-off logic

LLM-agnostic requirement:

- Alert thresholds, parsing mappings, compliance state transitions, and evaluation scores must be deterministic code.
- Message wording can vary, but the decision to alert or score a week must not rely on model-specific interpretation.

---

## API Changes

No external HTTP API changes are required.

This epic is local-script and DB driven.

The user-facing interfaces remain:

- Telegram messages from cron jobs
- markdown artifacts in repo memory locations
- structured DB state for later analysis

---

## Process Changes

- Introduce `today mission` as the daily source-of-truth object before the morning brief is rendered.
- Run conversation sync and check-in parsing on a reliable cadence so inbound updates are captured promptly.
- Standardize alert generation through `alert-policy.ts` rather than embedding policy separately across multiple jobs.
- Compute weekly outcome evaluation before the weekly summary is finalized.

---

## Orchestration Changes

No infrastructure orchestration changes are required, but cron composition changes are likely.

Recommended logical order for a full coaching day:

1. build athlete-state row
2. build or refresh today mission
3. render morning brief
4. sync user check-ins throughout the day
5. evaluate alerts as new inputs arrive
6. render evening recap
7. close daily compliance state
8. compute weekly outcome score on Sundays

---

## Test Plan

Add new tests:

- `tests/cron/fitness-today-mission-data.test.ts`
- `tests/cron/fitness-post-workout-note-parser.test.ts`
- `tests/cron/fitness-alert-policy.test.ts`
- `tests/cron/fitness-checkin-db.test.ts`
- `tests/cron/fitness-outcome-eval.test.ts`

Update existing tests:

- `tests/cron/fitness-cron-contract.test.ts`
- `tests/cron/fitness-morning-brief-data.test.ts`
- `tests/cron/fitness-evening-recap-data.test.ts`
- `tests/cron/fitness-weekly-insights-data.test.ts`

Expected coverage:

- today mission artifact structure
- compliance extraction from natural-language check-ins
- soreness and pain parsing fallback behavior
- alert dedupe and severity logic
- weekly outcome scoring and explanation generation
- cron contract stability after any job changes
