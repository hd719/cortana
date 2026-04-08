# Technical Specification - Spartan Fitness Core Baseline

**Document Status:** Implemented

Shipped on `main`; retained as the technical reference for the current system.

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | @hd |
| Epic | Spartan Fitness Core Baseline |

---

## Development Overview

Build a deterministic, data-clean coaching baseline in two repos. In `cortana-external`, fix Whoop pagination duplication, add payload quality metadata, and preserve clean provider data. In `cortana`, add a canonical daily athlete-state pipeline that merges Whoop, Tonal, meal logs, and coaching defaults; persist normalized per-muscle training volume and nutrition adherence; and update the morning, weekly, and monthly fitness artifacts to read from this canonical state. Keep the rollout scoped to the current Tonal + Whoop + nutrition stack, defer Apple Health and full Tonal workout generation, and encode training rules through explicit config files and test-covered deterministic functions so any LLM can implement or extend the system without relying on model-specific reasoning.

---

## Data Storage Changes

### Database Changes

#### [NEW] public.cortana_fitness_athlete_state_daily

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK, NOT NULL | state_date | DATE | Local athlete-state date in `America/New_York`. |
| NOT NULL, DEFAULT NOW() | generated_at | TIMESTAMPTZ | Builder timestamp. |
|  | readiness_score | NUMERIC(6,2) | Canonical readiness score. |
|  | readiness_band | TEXT | `green`, `yellow`, `red`, `unknown`. |
|  | readiness_confidence | NUMERIC(4,3) | `0.000-1.000`. |
|  | sleep_hours | NUMERIC(6,2) | Canonical sleep hours. |
|  | sleep_performance | NUMERIC(6,2) | Whoop sleep performance percentage. |
|  | hrv | NUMERIC(8,2) | Canonical HRV value. |
|  | rhr | NUMERIC(8,2) | Canonical resting heart rate. |
|  | whoop_strain | NUMERIC(8,2) | Deduped same-day strain total. |
|  | whoop_workouts | INT | Deduped same-day workout count. |
|  | step_count | INT | Nullable until step source is reliable. |
|  | step_source | TEXT | `cycle`, `steps_collection`, `workouts_sum`, `unknown`, or `null`. |
|  | tonal_sessions | INT | Same-day Tonal session count. |
|  | tonal_volume | NUMERIC(12,2) | Same-day Tonal total volume. |
|  | cardio_minutes | NUMERIC(8,2) | Derived cardio duration if inferable. |
|  | cardio_summary | JSONB | By-mode minutes and counts. |
|  | body_weight_kg | NUMERIC(6,2) | Nullable until a trusted source exists. |
|  | phase_mode | TEXT | `maintenance`, `lean_gain`, `gentle_cut`, `aggressive_cut`, `unknown`. |
|  | target_weight_delta_pct_week | NUMERIC(6,3) | Nullable advisory target. |
|  | protein_g | NUMERIC(8,2) | Daily logged protein. |
|  | protein_target_g | NUMERIC(8,2) | Phase-aware daily target. |
|  | calories_kcal | NUMERIC(8,2) | Daily logged calories. |
|  | carbs_g | NUMERIC(8,2) | Daily logged carbs. |
|  | fat_g | NUMERIC(8,2) | Daily logged fat. |
|  | hydration_liters | NUMERIC(8,3) | Daily logged hydration. |
|  | nutrition_confidence | TEXT | `high`, `medium`, `low`. |
|  | recommendation_mode | TEXT | `push`, `controlled_train`, `zone2_technique`, `recover`. |
|  | recommendation_confidence | NUMERIC(4,3) | `0.000-1.000`. |
| NOT NULL, DEFAULT `'{}'::jsonb` | quality_flags | JSONB | Duplicates, missing protein, stale provider data, unmapped movements, and similar warnings. |
| NOT NULL, DEFAULT `'{}'::jsonb` | source_refs | JSONB | Provider freshness, cache timestamps, and input provenance. |
| NOT NULL, DEFAULT `'{}'::jsonb` | raw | JSONB | Optional compact debug payload for deterministic reconstruction. |
| NOT NULL, DEFAULT NOW() | created_at | TIMESTAMPTZ | Creation timestamp. |
| NOT NULL, DEFAULT NOW() | updated_at | TIMESTAMPTZ | Update timestamp. |

#### [NEW] public.cortana_fitness_muscle_volume_daily

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK part 1, NOT NULL | state_date | DATE | Foreign-key-like link to athlete state date. |
| PK part 2, NOT NULL | muscle_group | TEXT | `chest`, `back`, `quads`, `hamstrings`, `glutes`, `shoulders`, `biceps`, `triceps`, `calves`, `core`. |
|  | direct_sets | NUMERIC(6,2) | Estimated direct hard sets for the day. |
|  | indirect_sets | NUMERIC(6,2) | Optional assistance volume. |
|  | hard_sets | NUMERIC(6,2) | Sum or adjusted training dose. |
|  | sessions | INT | Distinct session count touching the muscle group. |
|  | load_bucket_summary | JSONB | Counts by load bucket. |
|  | rep_bucket_summary | JSONB | Counts by rep bucket. |
|  | rir_estimate_avg | NUMERIC(4,2) | Average or inferred effort estimate. |
|  | source_confidence | NUMERIC(4,3) | Lowered when mapping or set data is incomplete. |
| NOT NULL, DEFAULT `'{}'::jsonb` | notes | JSONB | Unmapped movements, substitutions, and debug metadata. |
| NOT NULL, DEFAULT NOW() | created_at | TIMESTAMPTZ | Creation timestamp. |
| NOT NULL, DEFAULT NOW() | updated_at | TIMESTAMPTZ | Update timestamp. |

#### [UPDATE] public.coach_nutrition_log

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| Existing | date_local | DATE | Keep unique daily row. |
| Existing | protein_target_g | INT | Keep required target. |
| Existing | protein_actual_g | INT | Keep nullable actual protein. |
| Existing | hydration_status | TEXT | Keep for backwards compatibility. |
|  | calories_actual_kcal | NUMERIC(8,2) | New measured calorie total. |
|  | carbs_g | NUMERIC(8,2) | New measured carb total. |
|  | fats_g | NUMERIC(8,2) | New measured fat total. |
|  | hydration_liters | NUMERIC(8,3) | New measured hydration total. |
|  | meals_logged | INT | Count of parsed meal events. |
|  | confidence | TEXT | `high`, `medium`, `low`. |
|  | phase_mode | TEXT | Optional phase reference for the day. |

#### [UPDATE] public.coach_decision_log

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| Existing | ts_utc | TIMESTAMPTZ | Keep timestamp. |
| Existing | readiness_call | TEXT | Keep current enum-like check. |
| Existing | longevity_impact | TEXT | Keep current enum-like check. |
| Existing | top_risk | TEXT | Keep current summary. |
| Existing | reason_summary | TEXT | Keep rationale. |
| Existing | prescribed_action | TEXT | Keep action string. |
|  | decision_scope | TEXT | `daily`, `weekly`, `monthly`. |
|  | recommendation_mode | TEXT | Explicit coaching mode for downstream filtering. |
|  | confidence | NUMERIC(4,3) | Confidence in the recommendation. |
| NOT NULL, DEFAULT `'{}'::jsonb` | payload | JSONB | Structured explanation and source values. |

Notes:

- `cortana_fitness_daily_facts` remains in place as a summary table and compatibility surface.
- New artifact logic should prefer `cortana_fitness_athlete_state_daily` and use `cortana_fitness_daily_facts` only where summary rollups remain useful.

---

## Infrastructure Changes (if any?)

### SNS Topic Changes

None.

### SQS Queue Changes

None.

### Cache Changes

Provider cache behavior changes are required.

- `cortana-external/apps/external-service/src/whoop/service.ts` must dedupe workout records before persisting `whoop_data.json`.
- The cached Whoop payload should add a top-level `quality` object with fields such as:
  - `fetched_at`
  - `page_count`
  - `duplicate_workout_ids_removed`
  - `repeated_next_token_detected`
  - `data_window_start`
  - `data_window_end`
- Existing Tonal cache shape can remain stable for now, but Cortana should record freshness metadata from the current cache timestamp or health response into `source_refs`.

### S3 Changes

None.

### Secrets Changes

None.

### Network/Security Changes

None expected. Existing localhost fitness endpoints remain the only runtime integration points for this phase.

---

## Behavior Changes

The user-facing behavior changes are in the fitness artifacts and coaching logic.

- Morning brief:
  - reads athlete state instead of recomputing all logic inline
  - emits a recommendation mode and confidence score
  - explains the top limiting factor using canonical quality flags and training state
- Weekly insights:
  - reports direct-set totals by muscle family
  - identifies underdosed and overdosed muscle groups
  - reports nutrition adherence using measured coverage instead of weak assumptions when coverage exists
  - flags cut-rate risk, low sleep tolerance, and cardio interference when data supports it
- Monthly overview:
  - uses athlete-state coverage and muscle-volume coverage instead of shallow summary heuristics
  - distinguishes missing signal from true negative signal
- Failure behavior:
  - if provider or logging quality is weak, the system degrades safely and says why
  - no artifact should silently produce high-confidence training advice from duplicated or stale source data

---

## Application/Script Changes

New files in `cortana`:

- `tools/fitness/athlete-state-db.ts`
  - create and upsert the two new fitness state tables
  - provide SQL builders and query helpers
- `tools/fitness/athlete-state-data.ts`
  - build a canonical athlete-state record for a target date
  - merge Whoop, Tonal, meal log, and phase defaults
- `tools/fitness/training-engine.ts`
  - deterministic recommendation rules for daily mode and weekly adjustment suggestions
- `tools/fitness/spartan-defaults.ts`
  - explicit training, protein, cut-rate, cardio, and sleep defaults derived from the roadmap research
- `tools/fitness/tonal-movement-map.ts`
  - typed mapping from Tonal movement IDs or titles to muscle family, movement pattern, and mapping confidence

Updated files in `cortana`:

- `tools/fitness/signal-utils.ts`
  - expose normalized Whoop workout IDs
  - extract Tonal set activities and bucket them by load, reps, and cardio mode where possible
  - expose helpers that are pure and unit-testable
- `tools/fitness/meal-log.ts`
  - extend `#meal` parsing to support hydration aliases such as `water=` or `hydration=`
  - keep parsing deterministic and line-based
- `tools/fitness/coach-db.ts`
  - add new schema fields and upsert helpers for expanded nutrition and structured decision payloads
- `tools/fitness/morning-brief-data.ts`
  - build or load athlete state first
  - write daily coaching output from canonical state
- `tools/fitness/evening-recap-data.ts`
  - update end-of-day nutrition and recovery persistence to support athlete-state generation
- `tools/fitness/weekly-insights-data.ts`
  - replace raw payload-only weekly heuristics with athlete-state and muscle-volume queries
- `tools/fitness/monthly-overview-data.ts`
  - summarize monthly coverage from athlete-state storage and new nutrition fields

Updated files in `cortana-external`:

- `apps/external-service/src/whoop/service.ts`
  - dedupe paginated workout results
  - guard against repeated `next_token`
  - attach quality metadata before cache persistence
- `apps/external-service/src/whoop/routes.ts`
  - no path changes required
  - ensure route serialization preserves new `quality` metadata

LLM-agnostic implementation rule:

- No rule should exist only in prose or prompt wording.
- All thresholds and mappings must live in typed constants, explicit helper functions, or stable schema fields.
- Unmapped or low-confidence data must reduce recommendation confidence instead of being guessed away.

---

## API Changes

Detail the new API endpoints, or modifications to existing ones.

### [UPDATE] Whoop Internal Data Endpoint

| Field | Value |
|-------|-------|
| **API** | `GET /whoop/data` |
| **Description** | Returns the cached Whoop payload after workout dedupe and includes top-level quality metadata used by Cortana fitness scripts. |
| **Additional Notes** | No auth or route-path change. Existing consumers remain compatible if they ignore the new `quality` field. |

| Field | Detail |
|-------|--------|
| **Authentication** | None on localhost service |
| **URL Params** | None |
| **Request** | None |
| **Success Response** | JSON object containing existing Whoop sections plus `quality`, for example `{ "profile": {...}, "recovery": [...], "sleep": [...], "workouts": [...], "quality": { "fetched_at": "...", "page_count": 3, "duplicate_workout_ids_removed": 12, "repeated_next_token_detected": false } }` |
| **Error Responses** | Existing `401` and `502` style failure behavior remains in place for invalid auth or provider failures. |

No new public API endpoints are required in `cortana` for this phase because the coaching pipeline is currently local-script driven.

---

## Process Changes

- Keep the existing fitness cron schedule intact for this phase.
- Refactor the cron scripts so they all call shared athlete-state builder code instead of duplicating provider parsing logic.
- Update the fitness maintenance workflow so unmapped Tonal movements are triaged by editing `tools/fitness/tonal-movement-map.ts`.
- Add a lightweight validation step to the implementation checklist:
  - confirm no duplicated Whoop workout IDs
  - confirm athlete-state row exists for the target date
  - confirm weekly artifact can render with muscle-volume rows present

---

## Orchestration Changes

No Kubernetes, Docker, or serverless changes are required.

The only orchestration change is logical:

- the current cron scripts remain the entrypoints
- shared fitness builder modules become the source of truth beneath those entrypoints

If build time becomes materially slower later, a dedicated athlete-state refresh cron can be introduced, but it is not required for the first implementation.

---

## Test Plan

Testing must cover both repos and remain deterministic.

`cortana-external`

- Add `apps/external-service/src/__tests__/whoop-service.test.ts`.
- Extend `apps/external-service/src/__tests__/whoop-routes.test.ts`.
- Verify:
  - duplicate workout IDs across pages are removed
  - repeated `next_token` stops pagination safely
  - non-workout collections are preserved
  - `/whoop/data` returns the `quality` object

`cortana`

- Add `tests/cron/fitness-athlete-state-db.test.ts`.
- Add `tests/cron/fitness-athlete-state-data.test.ts`.
- Add `tests/cron/fitness-training-engine.test.ts`.
- Add `tests/cron/fitness-tonal-movement-map.test.ts`.
- Update:
  - `tests/cron/fitness-signal-utils.test.ts`
  - `tests/cron/fitness-meal-log.test.ts`
  - `tests/cron/fitness-facts-db.test.ts` if summary compatibility helpers change
  - `tests/cron/fitness-morning-brief-data.test.ts`
  - `tests/cron/fitness-evening-recap-data.test.ts`
  - `tests/cron/fitness-weekly-insights-data.test.ts`
  - `tests/cron/fitness-monthly-overview-data.test.ts`

Manual verification

- hit `http://127.0.0.1:3033/whoop/data` and confirm duplicate workout IDs are gone
- hit `http://127.0.0.1:3033/tonal/data?fresh=true` and confirm the builder still reads live Tonal data
- run the morning, weekly, and monthly fitness scripts against live local data
- query Postgres and confirm one athlete-state row and expected muscle-volume rows exist for the target day
