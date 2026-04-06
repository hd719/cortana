# Implementation Plan - Spartan Tonal Programming

**Document Status:** Implemented

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | @hd |
| Epic | Spartan Tonal Programming |
| Tech Spec | [Link to Tech Spec](../techspec/techspec-spartan-tonal-programming.md) |
| PRD | [Link to PRD](../prd/prd-spartan-tonal-programming.md) |

---

## Dependency Map

| Vertical | Dependencies | Can Start? |
|----------|-------------|------------|
| V1 - Tonal Catalog Normalization | Core Baseline | Start after baseline |
| V2 - Template Library | Training Intelligence | Start after training-intelligence rules exist |
| V3 - Session Planner | V1, V2 | Start after V1, V2 |
| V4 - Planner Artifact And Coaching Integration | V3 | Start after V3 |
| V5 - Tonal Data Validation | V1, V3, V4 | Start after V1, V3, V4 |

---

## Recommended Execution Order

```text
Week 1: V1 + V2 (parallel - normalize Tonal data and define the template system)
Week 2: V3 (build deterministic planner selection and session composition)
Week 3: V4 (persist artifacts and integrate planner output with Spartan messaging)
Week 4: V5 (validate against live Tonal data and harden payload assumptions)
```

---

## Sprint 1 - Normalize And Template

### Vertical 1 - Tonal Catalog Normalization

**cortana: Convert Tonal history into a planner-friendly catalog**

*Dependencies: Depends on Core Baseline*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/tonal-program-catalog.ts` to normalize Tonal workouts, programs, and movements into planner entities.
- [x] Sub-task 2: Create `/Users/hd/Developer/cortana/tools/fitness/tonal-plan-db.ts` schema helpers for `cortana_fitness_tonal_library_snapshot`.
- [x] Sub-task 3: Update `/Users/hd/Developer/cortana/tools/fitness/signal-utils.ts` with planner-specific Tonal extractors if existing helpers are not sufficient.
  Existing extractors were sufficient, so catalog normalization now consumes them directly without duplicating Tonal parsing logic.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-tonal-program-catalog.test.ts`.

#### Testing

- The same Tonal fixture always yields the same normalized catalog.
- Unknown or missing Tonal movement detail produces visible quality flags.
- Catalog snapshots preserve enough metadata for template selection and planner constraints.

---

### Vertical 2 - Template Library

**cortana: Define the structured Tonal template system**

*Dependencies: Depends on Training Intelligence*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/tonal-template-library.ts` with versioned templates for at least:
  - upper hypertrophy 45m
  - lower hypertrophy 45m
  - push 45m
  - pull 45m
  - full body 30m
  - recovery 30m
  - cut-support upper/lower variants
- [x] Sub-task 2: Persist template definitions in code or structured repo files, not prompt text.
- [x] Sub-task 3: Add selection helpers that map weekly recommendation outputs to candidate templates.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-tonal-template-library.test.ts`.

#### Testing

- Template lookup by goal, split, and duration is deterministic.
- Fallback templates exist for low-energy or time-constrained days.
- Template versioning prevents silent structure drift.

---

## Sprint 2 - Build The Planner

### Vertical 3 - Session Planner

**cortana: Generate deterministic tomorrow-session and next-week Tonal plans**

*Dependencies: Depends on V1, V2*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/tonal-session-planner.ts` to combine weekly recommendations, athlete-state context, and template candidates into a chosen session plan.
- [x] Sub-task 2: Add planner persistence in `/Users/hd/Developer/cortana/tools/fitness/tonal-plan-db.ts` for `cortana_fitness_planned_session`.
- [x] Sub-task 3: Support planner constraints for:
  - readiness
  - fatigue debt
  - available time
  - lagging muscles
  - cardio interference
  - soreness or recovery fallback
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-tonal-session-planner.test.ts`.

#### Important Planning Notes

- First release is read-only. Do not attempt remote Tonal workout creation.
- If no template fits with confidence, emit a structured fallback recommendation instead of pretending a precise session exists.
- Planner outputs must remain structured enough for later write-back or manual import work.

#### Testing

- A standard recommendation plus healthy readiness produces a confident tomorrow-session output.
- A low-readiness constraint pack chooses a lower-fatigue or recovery template.
- Missing Tonal detail lowers confidence and can trigger a fallback session.

---

## Sprint 3 - Persist And Surface The Plan

### Vertical 4 - Planner Artifact and Coaching Integration

**cortana: Persist structured planner artifacts and wire them into Spartan outputs**

*Dependencies: Depends on V3*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/tonal-plan-artifact.ts` to write JSON and markdown outputs under `/Users/hd/Developer/cortana/memory/fitness/plans/`.
- [x] Sub-task 2: Update `/Users/hd/Developer/cortana/tools/fitness/morning-brief-data.ts` or a dedicated tomorrow-plan script to surface the planner result concisely.
- [x] Sub-task 3: Update `/Users/hd/Developer/cortana/tools/fitness/specialist-prompts.md` with planner-specific deep-dive templates that align to the new artifacts.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-tonal-plan-artifact.test.ts`.

#### Testing

- Planner artifacts are written to predictable paths and contain the same structured plan as the DB row.
- Morning or tomorrow-facing outputs can read the planner artifact without reparsing raw Tonal data.
- Planner integration does not break existing cron contracts.

---

## Sprint 4 - Validate Against Live Tonal Data

### Vertical 5 - Tonal Data Validation

**cortana + cortana-external: Verify planner assumptions against the real Tonal payload shape and harden field preservation**

*Dependencies: Depends on V1, V3, V4*

#### Jira

- [x] Sub-task 1: Inspect live `http://127.0.0.1:3033/tonal/data?fresh=true` payloads and confirm planner-required fields are present.
- [x] Sub-task 2: Update `/Users/hd/Developer/cortana-external/apps/external-service/src/tonal/service.ts` if any planner-critical fields need more explicit preservation.
  Live validation confirmed the current service already preserves the required planner fields, so no service-code change was needed in this pass.
- [x] Sub-task 3: Extend `/Users/hd/Developer/cortana-external/apps/external-service/src/__tests__/tonal.test.ts` for planner-critical payload assumptions.
- [x] Sub-task 4: Run `vitest` in both repos for the new planner coverage.

#### Testing

- Live Tonal payloads are sufficient for catalog normalization and session planning.
- Planner assumptions are backed by tests and not only by one observed local payload.
- No direct Tonal write behavior exists in the released code path.

---

## Dependency Notes

### Training Intelligence before V2

The template library needs clear goal modes and recommendation shapes from Training Intelligence. Otherwise template selection would be arbitrary.

### V1 and V2 before V3

The session planner needs both normalized Tonal library data and a structured template system. Building the planner first would create brittle logic and duplicate assumptions.

### V3 before V4

Artifact and coaching integration should only consume persisted planner outputs, not partial planner logic embedded in cron scripts.

---

## Scope Boundaries

### In Scope (This Plan)

- Tonal catalog normalization
- structured template library
- deterministic session planning
- persisted plan artifacts
- concise Spartan integration for tomorrow-session guidance

### External Dependencies

- stable enough Tonal read payloads from `cortana-external`
- training-intelligence recommendation outputs
- existing athlete-state and fatigue context from baseline and training intelligence

### Integration Points

- Reads `http://127.0.0.1:3033/tonal/data?fresh=true`
- Reads weekly recommendation outputs and athlete-state rows
- Writes `cortana_fitness_tonal_library_snapshot`
- Writes `cortana_fitness_program_template`
- Writes `cortana_fitness_planned_session`
- Writes planner artifacts under `memory/fitness/plans/`

---

## Realistic Delivery Notes

This epic should resist the temptation to do too much. The valuable first release is a trustworthy read-only planner. Direct Tonal write-back can be pursued later only if a stable private endpoint is proven and sufficiently safe.

- **Biggest risks:** payload-shape drift in unofficial Tonal data, incomplete template taxonomy, and overfitting the planner to a narrow set of observed workouts.
- **Assumptions:** the first release stays read-only, current Tonal fields remain available, and operator review of artifacts is acceptable before any stronger automation is attempted.
