# Technical Specification - Spartan Tonal Programming

**Document Status:** Implemented

Shipped on `main`; retained as the technical reference for the current system.

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | @hd |
| Epic | Spartan Tonal Programming |

---

## Development Overview

Build a Tonal-first programming layer in `cortana` that translates weekly training recommendations into deterministic session templates, classified Tonal library metadata, and structured tomorrow-session outputs without relying on Tonal write APIs in the first release. Use existing Tonal workout and movement data plus the training-intelligence outputs to classify current programs, maintain reusable templates by goal and split, generate session artifacts that fit time and recovery constraints, and keep all logic explicit, typed, and test-covered so any LLM can implement or extend the planner without hidden reasoning or private-API assumptions.

---

## Data Storage Changes

### Database Changes

#### [NEW] public.cortana_fitness_tonal_library_snapshot

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK, NOT NULL | snapshot_date | DATE | Local snapshot date. |
| NOT NULL | generated_at | TIMESTAMPTZ | Snapshot build time. |
|  | user_id | TEXT | Tonal user identifier if available. |
|  | workouts_seen | INT | Distinct workouts cataloged. |
|  | movements_seen | INT | Distinct movements cataloged. |
|  | strength_scores_present | BOOLEAN | Whether strength-score data was present in the snapshot. |
| NOT NULL, DEFAULT `'{}'::jsonb` | program_summary | JSONB | Program names, streak context, and inferred split metadata. |
| NOT NULL, DEFAULT `'{}'::jsonb` | movement_summary | JSONB | Movement taxonomy coverage and unmapped entities. |
| NOT NULL, DEFAULT `'{}'::jsonb` | quality_flags | JSONB | Missing detail, payload drift, and classification issues. |
| NOT NULL, DEFAULT `'{}'::jsonb` | raw | JSONB | Compact debug snapshot. |
| NOT NULL, DEFAULT NOW() | created_at | TIMESTAMPTZ | Creation timestamp. |

#### [NEW] public.cortana_fitness_program_template

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK, NOT NULL | template_id | TEXT | Stable identifier such as `upper-hypertrophy-45m-v1`. |
| NOT NULL | version | INT | Monotonic template version. |
| NOT NULL | goal_mode | TEXT | `hypertrophy`, `maintenance`, `recovery`, `cut_support`, `strength_bias`. |
| NOT NULL | split_type | TEXT | `upper_lower`, `ppl`, `full_body`, `recovery`, `fallback`. |
| NOT NULL | duration_minutes | INT | Nominal session length. |
|  | tonal_required | BOOLEAN | Whether Tonal is required for execution. |
| NOT NULL, DEFAULT `'{}'::jsonb` | template_body | JSONB | Ordered blocks, exercise slots, and set targets. |
| NOT NULL, DEFAULT `'{}'::jsonb` | tags | JSONB | Lagging-muscle emphasis, cut-safe, low-fatigue, and similar tags. |
| NOT NULL | active | BOOLEAN | Active template toggle. |
| NOT NULL, DEFAULT NOW() | created_at | TIMESTAMPTZ | Creation timestamp. |
| NOT NULL, DEFAULT NOW() | updated_at | TIMESTAMPTZ | Update timestamp. |

#### [NEW] public.cortana_fitness_planned_session

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK, NOT NULL | id | UUID | Default `gen_random_uuid()`. |
|  | state_date | DATE | Intended session date. |
|  | iso_week | TEXT | Related training week. |
| NOT NULL | plan_type | TEXT | `tomorrow`, `next_week`, `recovery_fallback`, `travel_fallback`. |
| NOT NULL | source_template_id | TEXT | Chosen template identifier or `custom-generated`. |
| NOT NULL | confidence | NUMERIC(4,3) | Planning confidence. |
| NOT NULL | target_duration_minutes | INT | Time budget. |
| NOT NULL, DEFAULT `'{}'::jsonb` | target_muscles | JSONB | Intended emphasis and dose. |
| NOT NULL, DEFAULT `'{}'::jsonb` | session_blocks | JSONB | Ordered plan blocks and movement slots. |
| NOT NULL, DEFAULT `'{}'::jsonb` | constraints | JSONB | Readiness, soreness, time, lagging muscles, cardio context. |
| NOT NULL, DEFAULT `'{}'::jsonb` | rationale | JSONB | Why the session was chosen. |
|  | artifact_path | TEXT | Optional markdown or JSON artifact path. |
| NOT NULL | created_at | TIMESTAMPTZ | Creation timestamp. |

#### [UPDATE] public.cortana_fitness_recommendation_log

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| Existing | recommendation_scope | TEXT | Keep `daily` and `weekly`. |
|  | planner_session_id | UUID | Optional link to `cortana_fitness_planned_session`. |
| NOT NULL, DEFAULT `'{}'::jsonb` | planner_context | JSONB | Template, duration, and constraint pack used by the planner. |

---

## Infrastructure Changes (if any?)

### SNS Topic Changes

None.

### SQS Queue Changes

None.

### Cache Changes

The current Tonal cache remains the primary source.

Recommended enhancements:

- Ensure `cortana-external/apps/external-service/src/tonal/service.ts` preserves the set-level activity fields needed for planner classification.
- Add a quality flag when expected workout detail or movement identifiers are missing from the payload.

### S3 Changes

None.

### Secrets Changes

None beyond existing Tonal auth secrets.

### Network/Security Changes

None in the first release because planner output is read-only and local.

---

## Behavior Changes

- Spartan gains a deterministic session-planning capability:
  - tomorrow-session recommendation
  - next-week Tonal-ready session sequence
  - recovery fallback sessions
  - travel or no-Tonal fallback sessions
- Weekly coaching can now name the actual type of session Spartan wants next, not only abstract volume adjustments.
- Planner outputs stay explicit when confidence is low:
  - missing mapping
  - poor recovery
  - insufficient Tonal detail
  - unavailable time or conflicting constraints

The first release does not attempt to create or edit Tonal workouts remotely. It creates artifacts and structured outputs only.

---

## Application/Script Changes

New files in `cortana`:

- `tools/fitness/tonal-program-catalog.ts`
  - normalize Tonal workout history into a planner-friendly catalog
- `tools/fitness/tonal-template-library.ts`
  - structured template definitions and selection helpers
- `tools/fitness/tonal-plan-db.ts`
  - schema creation and query helpers for planner tables
- `tools/fitness/tonal-session-planner.ts`
  - deterministic tomorrow-session and next-week session planning
- `tools/fitness/tonal-plan-artifact.ts`
  - emit JSON and markdown artifacts to disk

Updated files in `cortana`:

- `tools/fitness/signal-utils.ts`
  - expose planner-ready Tonal workout and movement helpers
- `tools/fitness/weekly-plan-data.ts`
  - hand off next-step recommendations into the session planner
- `tools/fitness/morning-brief-data.ts`
  - optionally surface the structured tomorrow-session output in brief form
- `tools/fitness/specialist-prompts.md`
  - add planner and program-analysis templates consistent with the new structured outputs

Updated files in `cortana-external`:

- `apps/external-service/src/tonal/service.ts`
  - verify or extend field preservation for planner-critical workout details
- `apps/external-service/src/__tests__/tonal.test.ts`
  - cover planner-relevant payload fields and shape stability

Artifact locations:

- `memory/fitness/plans/YYYY-MM-DD-tomorrow-session.json`
- `memory/fitness/plans/YYYY-MM-DD-tomorrow-session.md`
- `memory/fitness/programs/json/current-tonal-catalog.json`

LLM-agnostic requirement:

- Template bodies, movement slots, and session-selection rules must be structured data or typed constants.
- Prompt prose may explain the plan, but prompt prose must not be the source of truth for template structure.

---

## API Changes

No new first-release API endpoints are required in `cortana`.

Potential `cortana-external` update:

### [UPDATE] Tonal Internal Data Endpoint

| Field | Value |
|-------|-------|
| **API** | `GET /tonal/data?fresh=true` |
| **Description** | Continues to return workout history and planner-critical detail fields used by the Tonal planner. |
| **Additional Notes** | No route-path change expected. The implementation may expand quality metadata or preserve more detail fields if required. |

| Field | Detail |
|-------|--------|
| **Authentication** | None on localhost service |
| **URL Params** | `fresh=true` optional cache refresh path |
| **Request** | None |
| **Success Response** | Existing Tonal payload shape plus any additional quality metadata needed by the planner |
| **Error Responses** | Existing unhealthy or upstream failure behavior remains in place |

No Tonal write endpoint is part of this spec.

---

## Process Changes

- Add a catalog refresh step before or inside planner builds so template selection uses the latest Tonal library snapshot.
- Store planner templates in code or structured repo files and review them like source code.
- Treat any future Tonal write-back path as a separate gated follow-up, not part of this epic.

---

## Orchestration Changes

No new infrastructure orchestration is required.

Recommended logical flow:

1. refresh or read Tonal catalog
2. read weekly recommendation outputs
3. resolve planner constraints for the target day
4. select template or fallback plan
5. persist `planned_session` row
6. write operator-friendly artifacts

---

## Test Plan

Add new tests:

- `tests/cron/fitness-tonal-program-catalog.test.ts`
- `tests/cron/fitness-tonal-template-library.test.ts`
- `tests/cron/fitness-tonal-session-planner.test.ts`
- `tests/cron/fitness-tonal-plan-db.test.ts`
- `tests/cron/fitness-tonal-plan-artifact.test.ts`

Update existing tests:

- `tests/cron/fitness-signal-utils.test.ts`
- `tests/cron/fitness-morning-brief-data.test.ts`
- `cortana-external/apps/external-service/src/__tests__/tonal.test.ts`

Expected coverage:

- catalog classification from fixture Tonal payloads
- template selection by split, goal, and duration
- low-confidence fallback when inputs are weak
- tomorrow-session artifact generation
- planner behavior under readiness, soreness, and lagging-muscle constraints
