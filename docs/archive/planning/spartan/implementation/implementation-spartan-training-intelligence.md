# Implementation Plan - Spartan Training Intelligence

**Document Status:** Implemented

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | @hd |
| Epic | Spartan Training Intelligence |
| Tech Spec | [Link to Tech Spec](../techspec/techspec-spartan-training-intelligence.md) |
| PRD | [Link to PRD](../prd/prd-spartan-training-intelligence.md) |

---

## Dependency Map

| Vertical | Dependencies | Can Start? |
|----------|-------------|------------|
| V1 - Weekly Dose Engine | Core Baseline | Start after baseline |
| V2 - Fatigue And Progression Engines | Core Baseline | Start after baseline |
| V3 - Goal Mode And Cardio Rules | Core Baseline | Start after baseline |
| V4 - Weekly Recommendation Artifact | V1, V2, V3 | Start after V1, V2, V3 |
| V5 - Daily Artifact Integration | V4 | Start after V4 |
| V6 - Validation And Threshold Hardening | V1, V2, V3, V4, V5 | Start after V1-V5 |

---

## Recommended Execution Order

```text
Week 1: V1 + V2 + V3 (parallel - build the policy engines on top of baseline state)
Week 2: V4 (compose the weekly recommendation artifact and DB persistence)
Week 3: V5 (integrate with weekly and morning artifacts)
Week 4: V6 (threshold hardening, live validation, and documentation cleanup)
```

---

## Sprint 1 - Build Policy Engines

### Vertical 1 - Weekly Dose Engine

**cortana: Compute weekly muscle-dose status from canonical athlete-state and muscle-volume data**

*Dependencies: Depends on Core Baseline*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/volume-engine.ts` with phase-aware target bands by muscle group and deterministic `underdosed`, `adequate`, `overdosed`, `unknown` classification helpers.
- [x] Sub-task 2: Update `/Users/hd/Developer/cortana/tools/fitness/spartan-defaults.ts` with the first production target ranges and rule comments that explain intent, not implementation trivia.
- [x] Sub-task 3: Extend `/Users/hd/Developer/cortana/tools/fitness/athlete-state-db.ts` and add `/Users/hd/Developer/cortana/tools/fitness/training-intelligence-db.ts` to persist weekly dose outputs.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-volume-engine.test.ts`.

#### Testing

- Weekly direct-set totals map to the correct status by phase mode.
- Unknown mapping coverage lowers the status confidence instead of guessing.
- Target bands can be changed in one place without hidden downstream breakage.

---

### Vertical 2 - Fatigue and Progression Engines

**cortana: Model fatigue debt, sleep debt, progression momentum, and deload conditions**

*Dependencies: Depends on Core Baseline*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/fatigue-engine.ts` with deterministic functions for rolling fatigue debt, sleep debt, and deload triggers.
- [x] Sub-task 2: Create `/Users/hd/Developer/cortana/tools/fitness/progression-engine.ts` for progression momentum and plateau detection using Tonal output and recent recovery context.
- [x] Sub-task 3: Extend `/Users/hd/Developer/cortana/tools/fitness/athlete-state-data.ts` to persist per-day fatigue contributions needed by weekly rollups.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-fatigue-engine.test.ts` and `/Users/hd/Developer/cortana/tests/cron/fitness-progression-engine.test.ts`.

#### Testing

- Low sleep plus high load increases fatigue debt in a predictable way.
- Stalled output plus elevated fatigue produces a plateau or deload recommendation signal.
- Strong recovery plus productive output preserves positive progression momentum.

---

### Vertical 3 - Goal Mode and Cardio Rules

**cortana: Encode lean-gain, maintenance, and cut-aware policy differences plus cardio interference logic**

*Dependencies: Depends on Core Baseline*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/goal-mode.ts` to resolve phase defaults and related targets from athlete-state inputs and manual overrides.
- [x] Sub-task 2: Add cardio mode and interference helpers in `/Users/hd/Developer/cortana/tools/fitness/training-engine.ts` or a dedicated helper module if the file becomes too large.
- [x] Sub-task 3: Update `/Users/hd/Developer/cortana/tools/fitness/signal-utils.ts` and `/Users/hd/Developer/cortana/tools/fitness/athlete-state-data.ts` so cardio mode and dose are available as structured inputs.
- [x] Sub-task 4: Add tests covering walking, cycling, running, and HIIT in `/Users/hd/Developer/cortana/tests/cron/fitness-training-engine.test.ts`.

#### Testing

- Running and HIIT produce higher interference risk than walking or cycling at comparable doses.
- Cut modes preserve productive resistance work unless fatigue and recovery justify a more conservative call.
- Missing phase mode lowers confidence instead of inventing a goal state.

---

## Sprint 2 - Compose Weekly Intelligence

### Vertical 4 - Weekly Recommendation Artifact

**cortana: Build and persist the structured weekly training-state and next-week plan**

*Dependencies: Depends on V1, V2, V3*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/weekly-plan-data.ts` to compose the weekly training-state row, next-week recommendation summary, and operator-facing artifact payload.
- [x] Sub-task 2: Add weekly storage helpers in `/Users/hd/Developer/cortana/tools/fitness/training-intelligence-db.ts`.
- [x] Sub-task 3: Write recommendation rows into `cortana_fitness_recommendation_log` and weekly state rows into `cortana_fitness_training_state_weekly`.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-weekly-plan-data.test.ts` and `/Users/hd/Developer/cortana/tests/cron/fitness-training-intelligence-db.test.ts`.

#### Important Planning Notes

- The weekly artifact should be structured JSON first and human text second.
- Every recommended change should have a rationale and confidence value.
- Recommendation outputs must be easy for later Tonal-planning code to consume directly.

#### Testing

- A valid 7-day fixture produces one weekly training-state row and one weekly recommendation row.
- The weekly artifact includes underdosed and overdosed muscles when fixtures are designed to trigger both.
- Low-quality inputs lower confidence and preserve explicit quality flags.

---

## Sprint 3 - Integrate With Daily And Weekly Coaching

### Vertical 5 - Daily Artifact Integration

**cortana: Use the weekly intelligence layer in operator-facing Spartan outputs**

*Dependencies: Depends on V4*

#### Jira

- [x] Sub-task 1: Update `/Users/hd/Developer/cortana/tools/fitness/weekly-insights-data.ts` to consume the structured weekly training-state artifact instead of raw heuristics.
- [x] Sub-task 2: Update `/Users/hd/Developer/cortana/tools/fitness/morning-brief-data.ts` so daily recommendations can account for weekly dose status, fatigue debt, and cut-aware logic.
- [x] Sub-task 3: Extend `/Users/hd/Developer/cortana/tools/fitness/coach-db.ts` if structured decision logging needs additional fields beyond the baseline plan.
- [x] Sub-task 4: Update tests in `/Users/hd/Developer/cortana/tests/cron/fitness-weekly-insights-data.test.ts` and `/Users/hd/Developer/cortana/tests/cron/fitness-morning-brief-data.test.ts`.

#### Testing

- Weekly insights render consistent next-week actions from the structured recommendation payload.
- Morning brief can become more conservative when weekly fatigue debt is elevated even if same-day readiness is not red.
- Existing cron messaging contracts remain intact.

---

## Sprint 4 - Harden And Validate

### Vertical 6 - Validation and Threshold Hardening

**cortana: Validate the policy outputs against real recent data and tighten thresholds where obvious errors appear**

*Dependencies: Depends on V1, V2, V3, V4, V5*

#### Jira

- [x] Sub-task 1: Run `vitest` in `/Users/hd/Developer/cortana`.
- [x] Sub-task 2: Build weekly training-state outputs across at least the last 4 completed weeks and inspect obvious outliers.
- [x] Sub-task 3: Compare generated underdose and overdose calls against the current Tonal history and weekly markdown summaries in `/Users/hd/Developer/cortana/memory/fitness/weekly`.
- [x] Sub-task 4: Tune thresholds in `/Users/hd/Developer/cortana/tools/fitness/spartan-defaults.ts` only after the deterministic test suite remains green.
  Threshold review was completed after the broad deterministic suite and live artifact checks remained green; current defaults were retained because early personal history is still sparse.

#### Testing

- All new and updated training-intelligence tests pass.
- Recent real weeks produce believable recommendations without obvious volume inflation or false precision.
- Confidence falls correctly when coverage is sparse or quality flags are elevated.

---

## Dependency Notes

### Core Baseline before V1-V3

This epic only makes sense once canonical athlete-state and muscle-volume data exist. Otherwise the policy engines would rebuild the same baseline logic in parallel.

### V1, V2, and V3 before V4

The weekly recommendation artifact depends on dose classification, fatigue/progression signals, and phase/cardio policy. Shipping the artifact before those engines exist would force a shallow, low-value schema.

### V4 before V5

Daily and weekly artifact integration should consume one structured weekly output instead of each artifact recomputing policy logic in its own file.

---

## Scope Boundaries

### In Scope (This Plan)

- weekly muscle-dose classification
- fatigue debt and progression logic
- cut-aware and cardio-interference policy
- structured weekly recommendation outputs
- integration of those outputs into weekly and morning coaching

### External Dependencies

- core baseline athlete-state and muscle-volume tables
- Tonal movement mapping from the baseline epic
- explicit operator or coach-driven phase mode until a stable phase source of truth exists

### Integration Points

- Reads `cortana_fitness_athlete_state_daily`
- Reads `cortana_fitness_muscle_volume_daily`
- Writes `cortana_fitness_training_state_weekly`
- Writes `cortana_fitness_recommendation_log`
- Feeds `weekly-insights-data.ts` and `morning-brief-data.ts`

---

## Realistic Delivery Notes

This epic should stay rule-based in the first implementation. The goal is not to predict perfectly; it is to make Spartan consistently coherent, explainable, and safer than ad hoc reasoning from raw provider payloads.

- **Biggest risks:** bad or incomplete movement mapping, weak phase-mode source of truth, and thresholds that are too aggressive before enough personal history exists.
- **Assumptions:** the baseline rollout is complete first, the operator is comfortable with deterministic policy defaults, and no Tonal workout write-back is attempted in this epic.
