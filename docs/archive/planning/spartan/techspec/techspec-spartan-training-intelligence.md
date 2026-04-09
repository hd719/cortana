# Technical Specification - Spartan Training Intelligence

**Document Status:** Implemented

Shipped on `main`; retained as the technical reference for the current system.

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | @hd |
| Epic | Spartan Training Intelligence |

---

## Development Overview

Extend the core baseline into a deterministic training-intelligence layer in `cortana` that converts canonical athlete-state and muscle-volume data into weekly dose classification, fatigue and progression signals, cut-aware rules, cardio-interference checks, and confidence-scored next-week recommendations. Keep the first implementation rule-based and explainable, build on the baseline athlete-state schema rather than inventing a parallel data path, and ensure every recommendation can be traced to explicit thresholds, source coverage, and testable logic so any LLM can implement or modify the system without relying on hidden reasoning.

---

## Data Storage Changes

### Database Changes

#### [NEW] public.cortana_fitness_training_state_weekly

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK, NOT NULL | iso_week | TEXT | ISO week key such as `2026-W15`. |
| NOT NULL | week_start | DATE | Inclusive local week start. |
| NOT NULL | week_end | DATE | Inclusive local week end. |
|  | phase_mode | TEXT | `maintenance`, `lean_gain`, `gentle_cut`, `aggressive_cut`, `unknown`. |
|  | athlete_state_days | INT | Count of athlete-state rows in the window. |
|  | mapped_training_days | INT | Days with usable mapped Tonal volume. |
|  | readiness_avg | NUMERIC(6,2) | Average readiness. |
|  | sleep_hours_avg | NUMERIC(6,2) | Average sleep hours. |
|  | strain_total | NUMERIC(8,2) | Total weekly strain. |
|  | tonal_sessions | INT | Weekly Tonal session count. |
|  | tonal_volume | NUMERIC(12,2) | Weekly Tonal volume. |
|  | fatigue_score | NUMERIC(6,2) | Rule-based fatigue debt score. |
|  | progression_score | NUMERIC(6,2) | Rule-based progression momentum score. |
|  | interference_risk_score | NUMERIC(6,2) | Cardio interference risk score. |
|  | confidence | NUMERIC(4,3) | Overall weekly recommendation confidence. |
| NOT NULL, DEFAULT `'{}'::jsonb` | underdosed_muscles | JSONB | Muscle groups below target with supporting data. |
| NOT NULL, DEFAULT `'{}'::jsonb` | adequately_dosed_muscles | JSONB | Muscle groups in target range. |
| NOT NULL, DEFAULT `'{}'::jsonb` | overdosed_muscles | JSONB | Muscle groups above recoverable target. |
| NOT NULL, DEFAULT `'{}'::jsonb` | cardio_context | JSONB | By-mode cardio dose and interference flags. |
| NOT NULL, DEFAULT `'{}'::jsonb` | recommendation_summary | JSONB | Rise, hold, fall, deload, recovery emphasis, and rationale. |
| NOT NULL, DEFAULT `'{}'::jsonb` | quality_flags | JSONB | Missing mapping, weak coverage, stale source, sparse nutrition, and similar warnings. |
| NOT NULL, DEFAULT `'{}'::jsonb` | raw | JSONB | Compact debug basis for deterministic re-computation. |
| NOT NULL, DEFAULT NOW() | created_at | TIMESTAMPTZ | Creation timestamp. |
| NOT NULL, DEFAULT NOW() | updated_at | TIMESTAMPTZ | Update timestamp. |

#### [NEW] public.cortana_fitness_recommendation_log

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK, NOT NULL | id | UUID | Default `gen_random_uuid()`. |
| NOT NULL | recommendation_scope | TEXT | `daily` or `weekly`. |
|  | state_date | DATE | Present for daily recommendations. |
|  | iso_week | TEXT | Present for weekly recommendations. |
| NOT NULL | mode | TEXT | `push`, `controlled_train`, `recover`, `deload`, `volume_rise`, `volume_hold`, `volume_fall`, or similar. |
|  | confidence | NUMERIC(4,3) | Recommendation confidence. |
| NOT NULL | rationale | TEXT | Human-readable reason summary. |
| NOT NULL, DEFAULT `'{}'::jsonb` | inputs | JSONB | Structured signals used for the recommendation. |
| NOT NULL, DEFAULT `'{}'::jsonb` | outputs | JSONB | Structured recommended changes by muscle group and training mode. |
| NOT NULL | created_at | TIMESTAMPTZ | Log timestamp. |

#### [UPDATE] public.cortana_fitness_athlete_state_daily

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| Existing | state_date | DATE | Keep baseline key. |
|  | fatigue_debt | NUMERIC(6,2) | Daily rolling fatigue contribution. |
|  | sleep_debt | NUMERIC(6,2) | Daily rolling sleep debt contribution. |
|  | progression_momentum | NUMERIC(6,2) | Daily momentum contribution for short-horizon decisions. |
| NOT NULL, DEFAULT `'{}'::jsonb` | training_context | JSONB | Daily rule inputs such as weekly set status, cardio mode, and cut severity. |

#### [UPDATE] public.cortana_fitness_muscle_volume_daily

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| Existing | state_date | DATE | Keep key. |
| Existing | muscle_group | TEXT | Keep key. |
|  | weekly_rollup_sets | NUMERIC(6,2) | Optional denormalized weekly total for fast reads. |
|  | weekly_status | TEXT | `underdosed`, `adequate`, `overdosed`, `unknown`. |
|  | target_sets_min | NUMERIC(6,2) | Target lower bound for the current phase. |
|  | target_sets_max | NUMERIC(6,2) | Target upper bound for the current phase. |

---

## Infrastructure Changes (if any?)

### SNS Topic Changes

None.

### SQS Queue Changes

None.

### Cache Changes

None beyond what the core baseline already establishes.

### S3 Changes

None.

### Secrets Changes

None.

### Network/Security Changes

None.

---

## Behavior Changes

- Weekly insights move from descriptive trend text to structured coaching:
  - underdosed muscles
  - overdosed muscles
  - fatigue debt
  - progression momentum
  - cardio interference risk
  - next-week plan summary
- Morning recommendations gain weekly-context awareness:
  - whether the athlete is already ahead of weekly volume
  - whether fatigue debt lowers overload confidence
  - whether current phase changes the recommended action
- The system becomes able to recommend:
  - add sets
  - hold volume
  - reduce junk fatigue
  - deload
  - swap cardio modality
  - protect heavy work during a cut

Failure behavior:

- If weekly signal quality is weak, the system emits conservative recommendations with lower confidence instead of making a false precise call.
- If muscle mapping coverage is insufficient, the system reports `unknown` or low-confidence for affected muscle groups.

---

## Application/Script Changes

New files in `cortana`:

- `tools/fitness/training-intelligence-db.ts`
  - schema creation and query helpers for weekly training state and recommendation logs
- `tools/fitness/volume-engine.ts`
  - phase-aware muscle-group dose targets and classification logic
- `tools/fitness/fatigue-engine.ts`
  - rolling fatigue debt, sleep debt, and deload-trigger rules
- `tools/fitness/progression-engine.ts`
  - progression momentum and plateau signal helpers
- `tools/fitness/goal-mode.ts`
  - resolve phase mode and target-loss/gain context
- `tools/fitness/weekly-plan-data.ts`
  - build the structured next-week recommendation artifact

Updated files in `cortana`:

- `tools/fitness/training-engine.ts`
  - baseline daily-mode logic becomes the shared recommendation engine and receives weekly-context inputs
- `tools/fitness/athlete-state-data.ts`
  - persist training-context fields and rolling fatigue contributors
- `tools/fitness/athlete-state-db.ts`
  - support new athlete-state and muscle-volume fields
- `tools/fitness/weekly-insights-data.ts`
  - read `cortana_fitness_training_state_weekly` and `cortana_fitness_recommendation_log`
- `tools/fitness/morning-brief-data.ts`
  - consume weekly-context recommendation outputs when generating the daily call
- `tools/fitness/spartan-defaults.ts`
  - add explicit phase-aware weekly set targets, cardio-interference rules, and deload triggers

LLM-agnostic requirement:

- Dose thresholds, fatigue rules, cut-aware logic, and cardio rules must live in typed code or config.
- Recommendation text may be generated from structured outputs, but the policy itself must not exist only in prose.

---

## API Changes

No external HTTP API changes are required for this epic.

The primary outputs are:

- Postgres weekly training-state rows
- Postgres recommendation-log rows
- local JSON/markdown artifacts generated by the cron scripts

If a later dashboard needs direct reads, it should query the DB or consume a dedicated internal endpoint as a separate follow-up.

---

## Process Changes

- Add a deterministic weekly training-state build step before or inside the weekly insights script.
- Keep the weekly cron contract stable at the message layer, but change the artifact source from raw payload heuristics to the weekly training-state tables.
- Establish a movement-mapping maintenance workflow:
  - unmapped movements appear in quality flags
  - new mappings are added in code, not hidden in prompts

---

## Orchestration Changes

No infrastructure orchestration changes are required.

Recommended logical order inside the weekly fitness workflow:

1. ensure daily athlete-state rows exist for the last 7 days
2. build weekly training-state and recommendation rows
3. render the weekly insights artifact
4. persist the operator-facing markdown mirror

---

## Test Plan

Add new tests:

- `tests/cron/fitness-volume-engine.test.ts`
- `tests/cron/fitness-fatigue-engine.test.ts`
- `tests/cron/fitness-progression-engine.test.ts`
- `tests/cron/fitness-training-intelligence-db.test.ts`
- `tests/cron/fitness-weekly-plan-data.test.ts`

Update existing tests:

- `tests/cron/fitness-weekly-insights-data.test.ts`
- `tests/cron/fitness-morning-brief-data.test.ts`
- `tests/cron/fitness-signal-utils.test.ts`

Expected coverage:

- weekly dose classification by muscle group and phase mode
- fatigue debt increase under low sleep + high load conditions
- deload triggers under repeated fatigue and stalled progression
- cardio interference flags for running and HIIT versus lower-impact modalities
- confidence reduction when signal quality is degraded
- weekly artifact rendering from structured weekly training state
