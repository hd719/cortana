# Implementation Plan - Spartan Fitness Core Baseline

**Document Status:** Implemented

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | @hd |
| Epic | Spartan Fitness Core Baseline |
| Tech Spec | [Link to Tech Spec](../techspec/techspec-spartan-fitness-core-baseline.md) |
| PRD | [Link to PRD](../prd/prd-spartan-fitness-core-baseline.md) |

---

## Dependency Map

| Vertical | Dependencies | Can Start? |
|----------|-------------|------------|
| V1 - Whoop Data Integrity | None | Start Now |
| V2 - Tonal Movement Mapping | None | Start Now |
| V3 - Nutrition Signal Upgrade | None | Start Now |
| V4 - Athlete State Persistence | V1, V2, V3 | Start after V1, V2, V3 |
| V5 - Coaching Artifact Migration | V4 | Start after V4 |
| V6 - Validation and Rollout Hardening | V1, V2, V3, V4, V5 | Start after V1-V5 |

---

## Recommended Execution Order

```text
Week 1: V1 + V2 + V3 (parallel - stabilize provider data, mapping, and nutrition inputs)
Week 2: V4 (build canonical athlete-state storage and deterministic builder)
Week 3: V5 (move morning, weekly, and monthly coaching to the new state)
Week 4: V6 (full regression pass, live validation, and rollout hardening)
```

---

## Sprint 1 - Stabilize Inputs

### Vertical 1 - Whoop Data Integrity

**cortana-external: Remove duplicate workout records and surface quality metadata before downstream coaching reads the cache**

*Dependencies: None*

#### Jira

- [x] Sub-task 1: Update `/Users/hd/Developer/cortana-external/apps/external-service/src/whoop/service.ts` so `fetchWhoopCollection()` tracks `next_token` values, stops on repeated tokens, and deduplicates workout records by stable record ID before returning the collection.
- [x] Sub-task 2: Add a small internal helper in `/Users/hd/Developer/cortana-external/apps/external-service/src/whoop/service.ts` or a nearby module to normalize Whoop record IDs and build the top-level `quality` payload.
- [x] Sub-task 3: Ensure the persisted cache returned by `/Users/hd/Developer/cortana-external/apps/external-service/src/whoop/routes.ts` preserves the new `quality` object without breaking existing consumers.
- [x] Sub-task 4: Add `vitest` coverage in `/Users/hd/Developer/cortana-external/apps/external-service/src/__tests__/whoop-service.test.ts` and extend `/Users/hd/Developer/cortana-external/apps/external-service/src/__tests__/whoop-routes.test.ts` for duplicate IDs, repeated pagination tokens, and route serialization.

#### Testing

- [x] A paginated fixture with repeated workout IDs returns only unique workout rows.
- [x] A fixture with a repeated `next_token` stops safely instead of looping or duplicating.
- [x] `/whoop/data` includes the `quality` block and existing sections still deserialize normally.

---

### Vertical 2 - Tonal Movement Mapping

**cortana: Translate Tonal workout activity into deterministic muscle-family volume**

*Dependencies: None*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/tonal-movement-map.ts` with a typed map for the highest-frequency Tonal movement IDs and titles seen in the current cache.
- [x] Sub-task 2: Update `/Users/hd/Developer/cortana/tools/fitness/signal-utils.ts` to expose pure helpers for Tonal set extraction, load buckets, rep buckets, and movement-to-muscle resolution.
- [x] Sub-task 3: Add an explicit unmapped-movement path that returns low confidence and a flag instead of guessing muscle assignment.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-tonal-movement-map.test.ts` and update `/Users/hd/Developer/cortana/tests/cron/fitness-signal-utils.test.ts`.

#### Testing

- [x] Known Tonal movements map to the intended muscle family consistently.
- [x] Unmapped Tonal movements are surfaced as unmapped and lower confidence instead of being silently assigned.
- [x] Set buckets and daily muscle totals are deterministic from the same fixture payload.

---

### Vertical 3 - Nutrition Signal Upgrade

**cortana: Expand meal-log parsing and nutrition persistence so phase-aware coaching has measured inputs**

*Dependencies: None*

#### Jira

- [x] Sub-task 1: Update `/Users/hd/Developer/cortana/tools/fitness/meal-log.ts` to parse hydration aliases such as `water=` and `hydration=` while preserving the existing `protein`, `calories`, `carbs`, and `fat` parsing contract.
- [x] Sub-task 2: Add typed phase defaults and protein/cut-rate targets in `/Users/hd/Developer/cortana/tools/fitness/spartan-defaults.ts`.
- [x] Sub-task 3: Update `/Users/hd/Developer/cortana/tools/fitness/coach-db.ts` to add schema fields and upsert support for calories, carbs, fats, hydration liters, meal count, confidence, and phase mode.
- [x] Sub-task 4: Extend `/Users/hd/Developer/cortana/tests/cron/fitness-meal-log.test.ts` and add `/Users/hd/Developer/cortana/tests/cron/fitness-coach-db.test.ts` if new SQL builders or helpers are introduced.

#### Testing

- [x] `#meal` lines with hydration fields are parsed into deterministic daily totals.
- [x] Existing meal-log inputs remain backward compatible.
- [x] New nutrition schema fields render valid SQL and persist nullable values safely.

---

## Sprint 2 - Build Canonical State

### Vertical 4 - Athlete State Persistence

**cortana: Build one canonical daily athlete-state record and normalized muscle-volume rows**

*Dependencies: Depends on V1, V2, V3*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/athlete-state-db.ts` with schema creation, upsert SQL builders, and query helpers for `cortana_fitness_athlete_state_daily` and `cortana_fitness_muscle_volume_daily`.
- [x] Sub-task 2: Create `/Users/hd/Developer/cortana/tools/fitness/athlete-state-data.ts` with a single exported builder that reads Whoop data, Tonal data, meal logs, coach nutrition rows, and defaults to produce a deterministic athlete-state payload for one day.
- [x] Sub-task 3: Update `/Users/hd/Developer/cortana/tools/fitness/facts-db.ts` only as needed for compatibility helpers, but keep `cortana_fitness_daily_facts` as a summary table rather than the new source of truth.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-athlete-state-db.test.ts` and `/Users/hd/Developer/cortana/tests/cron/fitness-athlete-state-data.test.ts` with fixture payloads that cover good data, duplicated data, missing nutrition, and unmapped Tonal movements.

#### Important Planning Notes

- The athlete-state builder must be a pure, deterministic module with explicit inputs and outputs.
- Do not hide thresholds in prompt text. Put them in `spartan-defaults.ts` and reference them directly from the builder.
- If body weight or phase mode is missing, persist `null` or `unknown` and lower confidence instead of fabricating values.

#### Testing

- [x] A known fixture creates exactly one athlete-state row for the target date.
- [x] The same fixture creates the expected muscle-volume rows by muscle family.
- [x] Missing or weak inputs produce quality flags and lower recommendation confidence instead of exceptions or fake certainty.

---

## Sprint 3 - Upgrade Coaching Outputs

### Vertical 5 - Coaching Artifact Migration

**cortana: Move morning, weekly, and monthly fitness artifacts onto the canonical athlete-state model**

*Dependencies: Depends on V4*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/training-engine.ts` with deterministic recommendation helpers for daily mode, weekly underdose/overdose calls, and confidence scoring.
- [x] Sub-task 2: Update `/Users/hd/Developer/cortana/tools/fitness/morning-brief-data.ts` to build or load athlete state first, then derive recommendation mode, top risk, and confidence from `training-engine.ts`.
- [x] Sub-task 3: Update `/Users/hd/Developer/cortana/tools/fitness/evening-recap-data.ts` to write nutrition and recovery fields that support the next athlete-state build.
- [x] Sub-task 4: Update `/Users/hd/Developer/cortana/tools/fitness/weekly-insights-data.ts` to query athlete-state and muscle-volume rows for weekly analysis instead of only parsing raw payloads.
- [x] Sub-task 5: Update `/Users/hd/Developer/cortana/tools/fitness/monthly-overview-data.ts` to report coverage, trend, and missing-signal reasons from athlete-state storage.
- [x] Sub-task 6: Extend or update `/Users/hd/Developer/cortana/tests/cron/fitness-morning-brief-data.test.ts`, `/Users/hd/Developer/cortana/tests/cron/fitness-evening-recap-data.test.ts`, `/Users/hd/Developer/cortana/tests/cron/fitness-weekly-insights-data.test.ts`, and `/Users/hd/Developer/cortana/tests/cron/fitness-monthly-overview-data.test.ts`.

#### Important Planning Notes

- Artifact scripts should consume canonical state and avoid re-parsing provider payloads wherever the shared builder already covers the logic.
- Recommendation confidence must fall when quality flags are present.
- Weekly and monthly text should say when data is missing or low confidence instead of masking uncertainty with generic coaching.

#### Testing

- [x] Morning brief can render from athlete state and produces the expected recommendation mode for green, yellow, red, and unknown scenarios.
- [x] Weekly insights report muscle-family set totals and identify at least one underdosed or overdosed area from fixtures designed to trigger those cases.
- [x] Monthly overview distinguishes missing signal from zero signal and uses athlete-state coverage counts.

---

## Sprint 4 - Validate and Harden

### Vertical 6 - Validation and Rollout Hardening

**cortana + cortana-external: Run the full regression pass and verify live local behavior before broader coaching expansion**

*Dependencies: Depends on V1, V2, V3, V4, V5*

#### Jira

- [x] Sub-task 1: Run `vitest` in `/Users/hd/Developer/cortana-external/apps/external-service` and `/Users/hd/Developer/cortana`.
- [x] Sub-task 2: Exercise live local endpoints `http://127.0.0.1:3033/whoop/data` and `http://127.0.0.1:3033/tonal/data?fresh=true` and verify cache integrity with spot checks on workout IDs and freshness metadata.
- [x] Sub-task 3: Run the morning, weekly, and monthly fitness scripts end to end against live local data and verify DB inserts using `psql`.
- [x] Sub-task 4: Update the roadmap or follow-up docs only if implementation discoveries materially change scope boundaries or ordering.

#### Testing

- [x] All new and updated tests pass in both repos.
- [x] Live local Whoop data no longer contains repeated workout IDs.
- [x] Live local artifacts render without regressing the existing cron contract.

---

## Dependency Notes

### V1 before V4

Athlete-state accuracy depends on deduped provider data. Building canonical state on top of duplicate Whoop workouts would hard-code bad data into the new source of truth.

### V2 before V4

Athlete-state storage needs a stable Tonal movement-to-muscle translation layer before it can produce meaningful muscle-volume rows.

### V3 before V4

Nutrition confidence and phase-aware targets belong in the athlete-state record. Shipping the state builder before the nutrition upgrade would force an avoidable second schema pass.

### V4 before V5

Artifact migration should happen only after the canonical state tables and query helpers exist. Otherwise the same raw parsing logic would continue to live in multiple scripts.

---

## Scope Boundaries

### In Scope (This Plan)

- Whoop dedupe and provider quality metadata
- Canonical athlete-state storage
- Tonal movement mapping and muscle-family volume accounting
- nutrition logging improvements and phase-aware defaults
- migration of morning, weekly, and monthly coaching outputs to the canonical state

### External Dependencies

- `cortana-external` local Whoop and Tonal service must remain available at `http://127.0.0.1:3033`
- unofficial Tonal API shape must remain compatible with the current service implementation
- phase mode may still require explicit operator or coach input even though body weight can now come from Apple Health reconciliation

### Integration Points

- Reads Whoop and Tonal data from the local external service
- Reads meal logs from `~/.openclaw/agents/spartan/sessions`
- Writes summary and coaching data to Postgres through `runPsql`
- Feeds the existing `cron-fitness` morning, evening, weekly, and monthly script entrypoints

---

## Realistic Delivery Notes

This plan intentionally builds the baseline in the smallest credible order: clean inputs first, canonical state second, artifact migration third. That sequencing keeps the system explainable and prevents a large amount of duplicated logic from surviving the refactor.

- **Biggest risks:** incomplete Tonal movement mapping, weak phase-mode source of truth, sparse health-source coverage in early rollout, and future unofficial Tonal API drift.
- **Assumptions:** no new UI surface is required, deterministic code-plus-tests remains the implementation standard rather than prompt-only behavior, and later Apple Health work can enrich but does not invalidate the baseline architecture.
