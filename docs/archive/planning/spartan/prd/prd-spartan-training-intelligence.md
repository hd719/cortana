# Product Requirements Document (PRD) - Spartan Training Intelligence

**Document Status:** Implemented

Shipped on `main`; retained as the design reference for the current system.

## Team

| Role | Assignee |
|------|----------|
| Primary Owner | @hd |
| Epic | Spartan Training Intelligence |

---

## Problem / Opportunity

The core baseline can make the current data trustworthy, but that still does not make Spartan a real training coach.

Without a training-intelligence layer, Spartan can:

- describe readiness,
- summarize recent activity,
- and flag risk conservatively,

but it still cannot reliably answer:

- was chest, back, or legs underdosed last week?
- should weekly volume rise, hold, or fall?
- is cardio helping conditioning or interfering with lower-body hypertrophy?
- should a cut preserve volume, deload, or reduce junk fatigue first?
- what should next week look like beyond a generic suggestion?

The opportunity is to turn clean athlete-state data into deterministic training decisions that reflect the evidence-backed rules already captured in the roadmap. This is the layer where Spartan stops being a readable dashboard and starts becoming a coach.

---

## Insights

- The evidence base is strong enough to encode explicit defaults for weekly set targets, frequency, load distribution, effort, cardio interference, and cut-aware training behavior.
- Personalized coaching depends on a clean canonical state first, but once that exists the next missing layer is weekly training interpretation, not more raw data collection.
- Training advice should be explainable and conservative under uncertainty. If movement mapping, nutrition, or sleep coverage is weak, confidence must drop before recommendation aggression rises.

Problems this project is not intended to solve:

- direct Tonal workout generation
- Apple Health ingestion
- a new visual dashboard
- medical or rehab programming
- speculative machine-learning models with no deterministic baseline

---

## Development Overview

Extend the core baseline into a deterministic training-intelligence layer in `cortana` that converts canonical athlete-state and muscle-volume data into weekly dose classification, fatigue and progression signals, cut-aware rules, cardio-interference checks, and confidence-scored next-week recommendations. Keep the first implementation rule-based and explainable, build on the baseline athlete-state schema rather than inventing a parallel data path, and ensure every recommendation can be traced to explicit thresholds, source coverage, and testable logic so any LLM can implement or modify the system without relying on hidden reasoning.

---

## Success Metrics

- `100%` of weeks with sufficient athlete-state coverage produce a structured weekly training-state record.
- `100%` of mapped muscle groups are classified each week as underdosed, adequately dosed, or overdosed when the data supports a call.
- `100%` of generated next-week recommendations include a confidence value and the top limiting factor behind the plan.
- `0` high-confidence weekly recommendations are emitted when prerequisite coverage is materially degraded by stale data, missing muscle mapping, or weak nutrition coverage.
- Weekly insights can answer all of the following from structured data:
  - what was trained
  - how much
  - what lagged
  - what exceeded recoverable dose
  - what should change next week

---

## Assumptions

- The core baseline athlete-state and muscle-volume tables exist before this epic starts.
- Tonal movement mapping is good enough to support meaningful weekly muscle-family estimates, even if some movements remain unmapped.
- The first version should be deterministic and rule-based rather than predictive or ML-driven.
- Weekly recommendations are advisory outputs for Spartan and do not directly mutate Tonal workouts in this phase.
- Body-weight and phase-mode logic may remain partially manual until the future health expansion lands.

---

## Out of Scope

- Tonal workout creation or upload
- Apple Health or body-composition source integration
- new UI surfaces outside existing cron and memory artifacts
- predictive model training or reinforcement-learning experimentation
- medical exercise restrictions or injury-specific rehab protocols

---

## High Level Requirements

> **Note:** Any provisioning and access requirements must also be listed for development.

| Requirement | Description | Notes |
|-------------|-------------|-------|
| [Requirement 1 - Weekly Dose Model](#requirement-1---weekly-dose-model) | Classify weekly training dose by muscle family using athlete-state and Tonal-derived volume data. | Must be deterministic and explainable. |
| [Requirement 2 - Fatigue And Progression Engine](#requirement-2---fatigue-and-progression-engine) | Track fatigue debt, progression momentum, and deload conditions from multi-day inputs. | Sleep and readiness must influence confidence. |
| [Requirement 3 - Goal And Phase Rules](#requirement-3---goal-and-phase-rules) | Apply different training logic for maintenance, lean gain, and cutting phases. | Cut-aware behavior is required. |
| [Requirement 4 - Cardio Interference Logic](#requirement-4---cardio-interference-logic) | Distinguish low-interference cardio from lower-body-conflicting work and adjust recommendations accordingly. | Walking, cycling, running, HIIT are not equivalent. |
| [Requirement 5 - Weekly Recommendation Output](#requirement-5---weekly-recommendation-output) | Produce structured next-week recommendations with confidence and rationale. | Feeds weekly artifacts and later Tonal planning. |

---

## Detailed User Stories

### Glossary

| Term | Meaning |
|------|---------|
| Weekly dose model | The logic that maps recent training into underdosed, adequate, or overdosed weekly volume by muscle family. |
| Fatigue debt | A rolling measure of accumulated sleep, readiness, and training-load stress that reduces recommendation aggressiveness. |
| Progression momentum | A directional indicator of whether recent training is supporting continued overload or stalling out. |
| Interference risk | The probability that conditioning work is reducing the quality or recoverability of hypertrophy-focused lower-body training. |
| Recommendation confidence | A structured trust score based on source quality, mapping coverage, nutrition support, and signal consistency. |

---

### Requirement 1 - Weekly Dose Model

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want weekly direct sets and load context by muscle family so that I can detect underdosed and overdosed areas. | Must use the canonical baseline tables instead of raw ad hoc parsing. |
| Accepted | As an athlete, I want the weekly summary to tell me which muscle groups need more work and which need restraint. | Needs explicit thresholds and confidence. |
| Accepted | As a developer, I want weekly dose rules encoded in typed constants and tests so they are portable across models. | No prompt-only rules. |

---

### Requirement 2 - Fatigue and Progression Engine

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want to model fatigue debt from readiness, sleep, and recent strain so that I do not recommend overload into obvious recovery failure. | Must remain conservative under stale data. |
| Accepted | As an athlete, I want plateau and progression signals based on training output and recovery context, not only raw volume totals. | Must use Tonal strength and session history where available. |
| Accepted | As an operator, I want deload triggers to be explainable instead of opaque. | Must store structured rationale. |

---

### Requirement 3 - Goal and Phase Rules

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want different weekly training defaults for maintenance, lean gain, and cut phases so that advice matches the current objective. | Phase may be manual initially. |
| Accepted | As an athlete, I want cuts to protect productive lifting instead of collapsing immediately into low-volume maintenance. | Must reflect the roadmap research. |
| Accepted | As an operator, I want explicit rules for when poor recovery should reduce volume first versus when poor nutrition should lower confidence only. | Safety and explainability matter. |

---

### Requirement 4 - Cardio Interference Logic

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want cardio mode and dose modeled explicitly so that walking and running are not treated as interchangeable. | Needs per-mode rules. |
| Accepted | As an athlete, I want lower-body hypertrophy recommendations to account for running or HIIT interference risk. | Must be visible in weekly coaching. |
| Accepted | As a developer, I want deterministic interference rules that can be tested from fixtures. | No fuzzy prompt-only interpretation. |

---

### Requirement 5 - Weekly Recommendation Output

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an athlete, I want a clear next-week plan summary stating what should go up, hold, or come down. | This is the bridge to future Tonal planning. |
| Accepted | As Spartan, I want to emit a structured recommendation artifact with confidence, key risks, and supporting metrics. | Must be consumable by weekly cron and later planners. |
| Accepted | As an operator, I want low-confidence recommendations labeled clearly so they are not mistaken for hard prescriptions. | Confidence must be part of the output contract. |

---

## Appendix

### Additional Considerations

This epic is where the scientific roadmap becomes code.

The design intent is:

- weekly volume is the primary hypertrophy dial
- frequency is a distribution tool
- fatigue and sleep constrain overload
- cut phases preserve productive lifting when possible
- cardio mode matters, especially for lower-body hypertrophy

### User Research

Current system observations that justify this epic:

- weekly artifacts still rely heavily on summary heuristics and sparse protein assumptions
- Tonal volume exists, but there is no formal underdose/overdose classifier
- readiness messaging exists, but next-week training prescriptions do not

Relevant prior docs:

- [Ultimate Fitness Trainer Roadmap](../../../../source/planning/spartan/roadmap/fitness-trainer-roadmap-2026-04-04.md)
- [Core Baseline PRD](./prd-spartan-fitness-core-baseline.md)
- [Program Index](../../../../source/planning/spartan/roadmap/spartan-fitness-program-index.md)

### Open Questions

- What should be the first production threshold bands for underdosed versus adequate versus overdosed weekly set counts by muscle group?
- Should cut-aware logic lower set targets globally or only for lower-confidence recovery situations?
- How should progression momentum weight Tonal strength-score trends versus movement-level output trends?
- Should interference risk remain advisory at first, or be allowed to lower weekly lower-body set targets automatically?

### Collaboration Topics

- This epic depends on the baseline schema and quality flags being stable first.
- The owner should decide whether phase mode is stored in DB, config, or a manual override file before implementation starts.

### Technical Considerations

Primary current files this epic will extend:

- `tools/fitness/weekly-insights-data.ts`
- `tools/fitness/morning-brief-data.ts`
- `tools/fitness/signal-utils.ts`
- `tools/fitness/facts-db.ts`
- `tools/fitness/coach-db.ts`

This epic should introduce a formal weekly training-state layer instead of bloating the artifact scripts with more inline heuristics.
