# Product Requirements Document (PRD) - Spartan Fitness Core Baseline

**Document Status:** Implemented

Shipped on `main`; retained as the design reference for the current system.

## Team

| Role | Assignee |
|------|----------|
| Primary Owner | @hd |
| Epic | Spartan Fitness Core Baseline |

---

## Problem / Opportunity

The current Spartan fitness stack has the right raw ingredients, but it is not yet a trustworthy coaching system.

What exists today is useful but fragmented:

- `cortana-external` can already pull rich Tonal and Whoop data.
- `cortana` already has morning, evening, weekly, and monthly fitness artifact builders.
- Spartan already has a dedicated identity and fitness cron lane.

What is still broken or incomplete:

- Whoop workout pagination is duplicating workouts, which corrupts strain and workout counts.
- Each artifact script reconstructs its own partial view of the athlete instead of reading one canonical daily state.
- Tonal data is rich, but it is not yet translated into muscle-family volume or progression logic.
- Nutrition exists structurally, but protein, calories, hydration, and phase adherence are still too weak to support high-confidence coaching.
- The system summarizes well, but it does not yet behave like a coach that can say what was trained, what is underdosed, and what should happen next.

The opportunity is to turn the current stack into a deterministic, evidence-backed coaching baseline that is reliable enough to build on. This is the foundation required before later work such as Apple Health ingestion or fully Tonal-native workout generation.

---

## Insights

- Data trust is the gating dependency. If duplicate workouts or stale provider data are allowed to flow into coaching, every later recommendation becomes suspect.
- Tonal already provides enough workout detail to support real training analysis. The missing layer is not more provider breadth; it is translation into muscle volume, effort, recovery, and phase-aware coaching.
- The literature is consistent enough to encode explicit defaults for hypertrophy, staying lean, protein, sleep, cut rate, and cardio interference. Those rules should live in code and config, not only in prompts.

Problems this project is not intended to solve:

- Apple Health integration
- injury diagnosis or medical coaching
- a new mobile UI or dashboard
- full Tonal custom workout generation
- replacing Tonal or Whoop with official developer platforms

---

## Development Overview

Build a deterministic, data-clean coaching baseline in two repos. In `cortana-external`, fix Whoop pagination duplication, add payload quality metadata, and preserve clean provider data. In `cortana`, add a canonical daily athlete-state pipeline that merges Whoop, Tonal, meal logs, and coaching defaults; persist normalized per-muscle training volume and nutrition adherence; and update the morning, weekly, and monthly fitness artifacts to read from this canonical state. Keep the rollout scoped to the current Tonal + Whoop + nutrition stack, defer Apple Health and full Tonal workout generation, and encode training rules through explicit config files and test-covered deterministic functions so any LLM can implement or extend the system without relying on model-specific reasoning.

---

## Success Metrics

Success means the baseline coaching loop is trustworthy, measurable, and explicit.

- Data integrity:
  - `0` duplicate workout IDs in persisted Whoop workout payloads across test fixtures and live cache refreshes.
  - `100%` of fitness artifacts emit explicit quality flags when data is stale, duplicated, or missing.
- Canonical athlete state:
  - `100%` of morning, weekly, and monthly fitness artifacts can read a persisted athlete-state record for the target day or range.
  - `100%` of athlete-state rows include readiness, sleep, strain, steps availability, Tonal load, nutrition confidence, and recommendation confidence.
- Tonal training translation:
  - `>= 90%` of recent Tonal workout set activities map to a known muscle family or are explicitly flagged as unmapped.
  - weekly insights include direct-set totals by muscle family for all mapped Tonal sessions.
- Nutrition signal quality:
  - weekly artifacts stop defaulting to `assume_likely_below_target_unverified` once logging coverage reaches `>= 5` of the trailing `7` days.
  - hydration and calorie fields are measurable when the user logs them, not silently dropped.
- Coaching behavior:
  - morning output can answer `what should I do today, why, and how confident is that call?`
  - weekly output can answer `what was underdosed, overdosed, and what should change next week?`

---

## Assumptions

- `cortana` remains the primary implementation repo and the home for the planning docs because most of the baseline logic lives there.
- `cortana-external` remains the provider ingestion layer and is responsible for data correctness before payloads reach coaching logic.
- Tonal unofficial endpoints continue to expose workout activities and strength score history in roughly the current shape.
- Meal logging continues to come from natural-language `#meal` entries in Spartan session files during this phase.
- Body weight and phase mode may remain partially manual until a later health-data integration exists.
- Existing `vitest` coverage in both repos is the default verification surface for this project.

---

## Out of Scope

- Apple Health ingestion
- new mobile or web UI surfaces
- wearable or device additions beyond Tonal and Whoop
- medical claims, injury treatment logic, or supplement recommendations
- fully automatic custom Tonal workout generation
- autonomous coaching actions that modify external systems without operator review

---

## High Level Requirements

> **Note:** Any provisioning and access requirements must also be listed for development.

| Requirement | Description | Notes |
|-------------|-------------|-------|
| [Requirement 1 - Provider Data Integrity](#requirement-1---provider-data-integrity) | Deduplicate provider data, preserve freshness, and expose quality flags before coaching logic runs. | Cross-repo; `cortana-external` first. |
| [Requirement 2 - Canonical Athlete State](#requirement-2---canonical-athlete-state) | Persist one daily athlete-state record that all fitness artifacts can read. | Primary work in `cortana`. |
| [Requirement 3 - Tonal Training Translation](#requirement-3---tonal-training-translation) | Convert Tonal workouts into muscle-family volume, load, and progression signals. | Requires deterministic movement mapping. |
| [Requirement 4 - Nutrition And Phase Logic](#requirement-4---nutrition-and-phase-logic) | Measure protein, calories, hydration, and phase targets well enough to support lean gain and cut coaching. | Logging quality must be explicit. |
| [Requirement 5 - Coaching Output Upgrade](#requirement-5---coaching-output-upgrade) | Upgrade morning, weekly, and monthly outputs from summaries into explicit, confidence-scored coaching artifacts. | Must degrade safely when data is weak. |

---

## Detailed User Stories

Describe the "walls" of the development. Clearly state where we expect people to interact with our systems once the development is complete. Think of it as a napkin scratch UI with the data and functionality you expect a user to see and experience.

### Glossary

| Term | Meaning |
|------|---------|
| Athlete state | One persisted daily record that merges recovery, sleep, training load, nutrition, and coaching confidence. |
| Direct hard sets | Estimated weekly direct sets assigned to a muscle family from mapped Tonal movement activity. |
| Phase mode | The current body-composition mode, such as maintenance, lean gain, gentle cut, or aggressive cut. |
| Quality flag | A machine-readable warning such as duplicated workouts, stale provider data, missing steps, or missing protein signal. |
| Recommendation confidence | A numeric or labeled estimate of how much trust Spartan should place in a recommendation given the current data quality. |

---

### Requirement 1 - Provider Data Integrity

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want Whoop workouts deduplicated before they are cached so that strain and workout counts are real. | Deduplicate by stable workout ID. |
| Accepted | As an operator, I want stale or low-quality provider payloads flagged explicitly so that coaching never reasons over bad data silently. | Applies to Whoop first and Tonal freshness second. |
| Accepted | As a developer, I want pagination and cache quality tests so that later refactors cannot reintroduce duplicate provider data. | Tests belong in `cortana-external`. |

---

### Requirement 2 - Canonical Athlete State

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want one canonical daily athlete-state record so that morning, weekly, and monthly scripts do not each rebuild their own incomplete logic. | New shared storage and builder functions. |
| Accepted | As a developer, I want athlete-state generation to be deterministic and test-covered so any LLM can implement or modify it safely. | Rules must live in code and typed config. |
| Accepted | As an operator, I want athlete-state quality flags and source references persisted with the record so debugging does not require reverse-engineering artifact text. | Include source and freshness metadata. |

---

### Requirement 3 - Tonal Training Translation

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an athlete, I want Tonal sessions translated into muscle-family volume so that Spartan can detect underdosed and overdosed areas. | Chest, back, quads, hamstrings, glutes, shoulders, biceps, triceps, calves, core. |
| Accepted | As Spartan, I want unknown Tonal movements flagged instead of guessed so that missing taxonomy work is obvious and confidence degrades correctly. | No silent fallback mapping. |
| Accepted | As an athlete, I want weekly insights to explain what was trained and what should change next week. | Must include volume by muscle family. |

---

### Requirement 4 - Nutrition and Phase Logic

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an athlete, I want protein, calories, carbs, fat, and hydration parsed from my logs so that coaching is based on measured intake. | Extend existing `#meal` parsing rather than inventing a new logging system. |
| Accepted | As Spartan, I want phase-aware defaults for maintenance, lean gain, and cutting so that protein and calorie coaching matches the current goal. | Body weight may be nullable; logic must degrade safely. |
| Accepted | As an operator, I want low nutrition coverage called out explicitly instead of hidden behind optimistic assumptions. | Required for trustworthy weekly and monthly outputs. |

---

### Requirement 5 - Coaching Output Upgrade

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an athlete, I want the morning brief to tell me today's training mode, limiting factor, and confidence level. | Example modes: push, controlled train, Zone 2/technique, recover. |
| Accepted | As an athlete, I want the weekly artifact to tell me which muscle groups need more or less work and whether my nutrition supported the week. | Must reference athlete-state data, not raw payload heuristics. |
| Accepted | As an operator, I want monthly reporting to show coverage and trajectory based on canonical state so missing data is obvious and trends are credible. | Avoid shallow `unknown` reporting when measurable data exists. |

---

## Appendix

Include any additional supporting documents, charts, or diagrams here.

### Additional Considerations

This project must remain LLM agnostic.

That means:

- planning documents must name exact repos, files, tables, and tests
- decision logic must be encoded in deterministic functions and typed constants
- prompts may explain decisions, but prompts must not be the only place where rules live
- every requirement should be implementable by a fast model without hidden repo knowledge

### User Research

Observed current-state evidence:

- `whoop_data.json` contained repeated workout IDs and inflated same-day workout counts.
- `tonal_data.json` already contains workout history, strength scores, and set-level activity detail.
- `cortana_fitness_daily_facts` has live rows, but protein, hydration, and steps coverage are still weak.

Research themes already synthesized in the roadmap:

- weekly set volume is the main hypertrophy dial
- frequency mainly distributes volume
- a wide load range can build muscle when effort is sufficient
- sleep, protein, cut rate, and cardio mode materially affect staying lean while preserving muscle

Reference roadmap:

- [Ultimate Fitness Trainer Roadmap](../../../../source/planning/spartan/roadmap/fitness-trainer-roadmap-2026-04-04.md)

### Open Questions

- What should be the first authoritative source for body weight before Apple Health exists?
- Should phase mode live in a small config file, a DB row, or a lightweight manual override file in the repo?
- How much manual Tonal movement mapping is acceptable before introducing a semi-automated mapping helper?
- Should soreness and pain flags remain free-text in the evening artifact during this phase or gain a structured schema immediately?

### Collaboration Topics

- `cortana-external` changes should land before downstream confidence scoring is treated as production-trustworthy.
- The owner should decide where manual phase mode and body-weight overrides are stored if no existing source of truth already exists.

### Technical Considerations

Current fitness implementation surface:

- `tools/fitness/morning-brief-data.ts`
- `tools/fitness/evening-recap-data.ts`
- `tools/fitness/weekly-insights-data.ts`
- `tools/fitness/monthly-overview-data.ts`
- `tools/fitness/meal-log.ts`
- `tools/fitness/signal-utils.ts`
- `tools/fitness/facts-db.ts`
- `tools/fitness/coach-db.ts`
- `cortana-external/apps/external-service/src/whoop/service.ts`
- `cortana-external/apps/external-service/src/tonal/service.ts`

Existing tests already cover the current cron and fitness surface, so this project should extend that coverage instead of inventing a new verification path.
