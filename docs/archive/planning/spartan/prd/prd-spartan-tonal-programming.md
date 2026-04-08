# Product Requirements Document (PRD) - Spartan Tonal Programming

**Document Status:** Implemented

Shipped on `main`; retained as the design reference for the current system.

## Team

| Role | Assignee |
|------|----------|
| Primary Owner | @hd |
| Epic | Spartan Tonal Programming |

---

## Problem / Opportunity

Training intelligence can decide what should happen next week, but that still leaves a practical gap:

- the recommendation may say chest volume should rise
- lower-body fatigue should stay controlled
- cardio interference should stay low
- tomorrow should be a controlled upper-body session

but Spartan still cannot reliably convert that into a Tonal-ready plan.

Today, the Tonal integration is strong on data retrieval:

- workout history
- strength scores
- set-level activity detail
- streak and profile information

What is missing is the programming layer that transforms coaching intent into concrete sessions, templates, and reusable blocks. The opportunity is to make Spartan answer the real operator question: `What should I do on Tonal tomorrow?`

---

## Insights

- Tonal already handles execution UX. Spartan does not need to replace Tonal; it needs to become the decision brain above Tonal.
- Because no official public Tonal developer API was found, the first Tonal-programming release should stay read-only and deterministic rather than depending on private write-back behavior.
- The planner must be structured enough that a later private-API or manual-import path can consume it without redoing the programming logic.

Problems this project is not intended to solve:

- direct mutation of Tonal workouts in the first release
- replacing Tonal’s built-in UI
- generalized gym programming outside the Tonal-first workflow
- Apple Health integration
- injury rehab or physical therapy programming

---

## Development Overview

Build a Tonal-first programming layer in `cortana` that translates weekly training recommendations into deterministic session templates, classified Tonal library metadata, and structured tomorrow-session outputs without relying on Tonal write APIs in the first release. Use existing Tonal workout and movement data plus the training-intelligence outputs to classify current programs, maintain reusable templates by goal and split, generate session artifacts that fit time and recovery constraints, and keep all logic explicit, typed, and test-covered so any LLM can implement or extend the planner without hidden reasoning or private-API assumptions.

---

## Success Metrics

- `100%` of planned Tonal sessions reference a known template or explicitly note why they are fallback/generated.
- `100%` of tomorrow-session recommendations include:
  - goal
  - target muscle groups
  - target session length
  - exercise/block structure
  - confidence
  - rationale
- `>= 90%` of recent Tonal workout activities are either mapped into the planner taxonomy or flagged for mapping follow-up.
- `0` first-release planning flows require direct Tonal workout creation or private write APIs.
- Spartan can answer `what should I do on Tonal tomorrow?` from structured planner output instead of freeform prompt improvisation.

---

## Assumptions

- The training-intelligence epic is complete enough to produce weekly dose and next-week recommendation outputs.
- The current Tonal data shape remains broadly stable for workout history and set-level activity detail.
- The first release should be Tonal-read-only and artifact-driven.
- Session templates can be stored in code or structured repo files before any future UI or database editor exists.
- User time constraints and readiness context are available from athlete-state data and current cron surfaces.

---

## Out of Scope

- direct Tonal workout creation through private endpoints
- Apple Health or body-composition logic
- non-Tonal primary programming workflows
- new mobile or web interfaces for session editing
- voice coaching or live rep-by-rep execution features

---

## High Level Requirements

> **Note:** Any provisioning and access requirements must also be listed for development.

| Requirement | Description | Notes |
|-------------|-------------|-------|
| [Requirement 1 - Tonal Library Classification](#requirement-1---tonal-library-classification) | Normalize Tonal programs, workouts, and movements into a planner-friendly catalog. | Read-only first. |
| [Requirement 2 - Template Library](#requirement-2---template-library) | Maintain reusable Tonal-first templates by split, goal, and session length. | Must be structured and versioned. |
| [Requirement 3 - Session Planner](#requirement-3---session-planner) | Generate deterministic tomorrow-session outputs from training-intelligence inputs. | Confidence and rationale required. |
| [Requirement 4 - Constraint Handling](#requirement-4---constraint-handling) | Respect recovery state, time windows, lagging muscles, and cardio conflicts when planning. | Avoid one-size-fits-all plans. |
| [Requirement 5 - Operator Artifacts](#requirement-5---operator-artifacts) | Persist Tonal-ready plan artifacts that Spartan and future tooling can consume. | Must work without private Tonal writes. |

---

## Detailed User Stories

### Glossary

| Term | Meaning |
|------|---------|
| Tonal library catalog | A normalized view of Tonal workouts, movements, and programs used by the planner. |
| Template | A reusable session or block structure such as upper hypertrophy 45-minute or lower recovery 30-minute. |
| Planner artifact | A structured JSON and/or markdown output describing a recommended session. |
| Constraint pack | Inputs such as readiness, available time, lagging muscles, soreness, and cut-aware limits. |
| Read-only Tonal planning | Planning that uses Tonal data to recommend sessions without attempting to write back into Tonal. |

---

### Requirement 1 - Tonal Library Classification

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want Tonal workouts and movements classified into planner-friendly categories so that future recommendations are structured, not improvised. | Must include split, movement family, and session type where inferable. |
| Accepted | As a developer, I want unknown or unstable Tonal entities surfaced explicitly so planner drift is visible. | No silent fallbacks. |
| Accepted | As an athlete, I want current Tonal history interpreted as program context, not only isolated workouts. | Program classification matters. |

---

### Requirement 2 - Template Library

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want a reusable library of Tonal-first templates by goal, split, and session length. | Hypertrophy, maintenance, recovery, and fallback templates are required. |
| Accepted | As an athlete, I want templates that fit real constraints such as 30, 45, or 60 minutes. | Session duration is part of the contract. |
| Accepted | As a developer, I want templates stored in structured code or files so any LLM can safely modify them. | No prompt-only template library. |

---

### Requirement 3 - Session Planner

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an athlete, I want Spartan to answer what I should do on Tonal tomorrow in a way that reflects my current weekly plan and recovery. | Must be deterministic. |
| Accepted | As Spartan, I want to assemble a session from target muscles, dose targets, and available templates. | Feeds daily coaching. |
| Accepted | As an operator, I want the recommendation rationale and confidence made explicit. | Trust matters. |

---

### Requirement 4 - Constraint Handling

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want to consider readiness, soreness, time, lagging muscles, and cardio conflicts before recommending a session. | Prevents generic programming. |
| Accepted | As an athlete, I want the planner to prefer lower-fatigue or shorter templates when recovery is compromised. | Must integrate with training intelligence. |
| Accepted | As a developer, I want constraint logic tested independently from prompt output. | Portable and deterministic. |

---

### Requirement 5 - Operator Artifacts

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want to persist structured plan artifacts so downstream automation or later Tonal integrations can consume them. | JSON-first, markdown second. |
| Accepted | As an athlete, I want planner outputs saved in an easy-to-review location. | Repo memory artifacts are acceptable first. |
| Accepted | As an operator, I want the first release to work even if Tonal private APIs are unstable or unavailable. | Read-only planning is the default. |

---

## Appendix

### Additional Considerations

This epic should be honest about Tonal API reality.

The first release should:

- read Tonal data
- classify Tonal history
- generate structured plan artifacts
- avoid writing back to Tonal until a private write path is proven and hardened separately

### User Research

Current-state evidence:

- Tonal service already exposes profile, workout history, and strength-score endpoints.
- Set-level Tonal activity exists in the cached data and is rich enough to support template and movement classification.
- The current gap is decision-to-session translation, not workout-history retrieval.

Related docs:

- [Training Intelligence PRD](./prd-spartan-training-intelligence.md)
- [Ultimate Fitness Trainer Roadmap](../../../../source/planning/spartan/roadmap/fitness-trainer-roadmap-2026-04-04.md)
- [Program Index](../../../../source/planning/spartan/roadmap/spartan-fitness-program-index.md)

### Open Questions

- Should the first template library live fully in code, or in versioned JSON/YAML files under `docs` or `memory`?
- How much of current Tonal program identity can be inferred reliably from the unofficial payload shape?
- Should tomorrow-session artifacts favor strict template selection first and freeform assembly second, or the reverse?
- When a good Tonal session cannot be built confidently, should Spartan fall back to a simple upper/lower recovery template or a manual recommendation only?

### Collaboration Topics

- This epic depends on stable weekly recommendation outputs from Training Intelligence.
- Any future Tonal write-back work should be spun out as a separate follow-up once a reliable private endpoint is proven.

### Technical Considerations

Existing current files and services that matter:

- `tools/fitness/signal-utils.ts`
- `tools/fitness/weekly-insights-data.ts`
- `cortana-external/apps/external-service/src/tonal/service.ts`
- `cortana-external/mjolnir/TONAL_SERVICE.md`

This epic should produce deterministic planning artifacts first, not speculative API mutations.
