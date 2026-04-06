# Implementation Plan - Spartan Coaching Operating Loop

**Document Status:** Implemented

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | @hd |
| Epic | Spartan Coaching Operating Loop |
| Tech Spec | [Link to Tech Spec](../techspec/techspec-spartan-coaching-operating-loop.md) |
| PRD | [Link to PRD](../prd/prd-spartan-coaching-operating-loop.md) |

---

## Dependency Map

| Vertical | Dependencies | Can Start? |
|----------|-------------|------------|
| V1 - Today Mission Layer | Core Baseline | Start after baseline |
| V2 - Structured Check-In Parsing | Core Baseline | Start after baseline |
| V3 - Alert Policy Framework | V1, V2 | Start after V1, V2 |
| V4 - Compliance And Outcome Evaluation | Training Intelligence, V1, V2 | Start after training intelligence and V1, V2 |
| V5 - Cron And Identity Integration | V1, V2, V3, V4 | Start after V1-V4 |

---

## Recommended Execution Order

```text
Week 1: V1 + V2 (parallel - define the daily mission and structured input path)
Week 2: V3 (standardize alerting and logging)
Week 3: V4 (close the loop with compliance and outcome evaluation)
Week 4: V5 (integrate cron contracts, memory expectations, and end-to-end validation)
```

---

## Sprint 1 - Establish The Daily Loop

### Vertical 1 - Today Mission Layer

**cortana: Create the structured daily mission artifact and make it the day-level coaching source of truth**

*Dependencies: Depends on Core Baseline*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/today-mission-data.ts` with a deterministic artifact contract built from athlete-state and daily recommendation inputs.
- [x] Sub-task 2: Update `/Users/hd/Developer/cortana/tools/fitness/morning-brief-data.ts` to generate or load the today mission before final brief rendering.
- [x] Sub-task 3: Persist or mirror today mission artifacts under a stable memory path such as `/Users/hd/Developer/cortana/memory/fitness/daily/`.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-today-mission-data.test.ts`.

#### Testing

- Today mission artifacts are deterministic from the same athlete-state input.
- Morning brief can render from the today mission without losing current contract fields.
- Low-confidence daily states result in a conservative mission and explicit uncertainty.

---

### Vertical 2 - Structured Check-In Parsing

**cortana: Parse natural-language user updates into structured check-ins**

*Dependencies: Depends on Core Baseline*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/post-workout-note-parser.ts` with deterministic entity extraction for completion, miss, soreness, pain, motivation, and schedule constraints.
- [x] Sub-task 2: Create `/Users/hd/Developer/cortana/tools/fitness/checkin-db.ts` and its schema helpers for `coach_checkin_log`.
- [x] Sub-task 3: Update `/Users/hd/Developer/cortana/tools/fitness/coach-conversation-sync.ts` to persist parsed entities and linked check-ins.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-post-workout-note-parser.test.ts` and `/Users/hd/Developer/cortana/tests/cron/fitness-checkin-db.test.ts`.

#### Testing

- Representative user messages classify correctly into completion, miss, soreness, pain, or schedule constraints.
- Ambiguous messages preserve raw text and lower parse confidence.
- Check-ins dedupe correctly by source key.

---

## Sprint 2 - Standardize Alerting

### Vertical 3 - Alert Policy Framework

**cortana: Replace one-off alert rules with a unified alert policy and alert log**

*Dependencies: Depends on V1, V2*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/alert-policy.ts` to evaluate freshness, recovery risk, overreach, missed protein, pain, and schedule conflict conditions.
- [x] Sub-task 2: Add `coach_alert_log` helpers in `/Users/hd/Developer/cortana/tools/fitness/checkin-db.ts` or a dedicated alert DB helper module.
- [x] Sub-task 3: Update alert-related cron logic in `~/.openclaw/cron/jobs.json` or supporting scripts so they call the new shared policy layer.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-alert-policy.test.ts` and extend `/Users/hd/Developer/cortana/tests/cron/fitness-cron-contract.test.ts`.

#### Testing

- Duplicate alerts are suppressed by stable alert keys.
- Alert severity changes predictably with stronger evidence.
- Existing freshness, recovery, and overreach alerts remain operational after refactor.

---

## Sprint 3 - Close The Loop

### Vertical 4 - Compliance and Outcome Evaluation

**cortana: Track adherence and score whether Spartan’s guidance is improving outcomes**

*Dependencies: Depends on Training Intelligence, V1, V2*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/outcome-eval.ts` with deterministic weekly outcome scoring rules.
- [x] Sub-task 2: Extend `/Users/hd/Developer/cortana/tools/fitness/coach-db.ts` or `/Users/hd/Developer/cortana/tools/fitness/checkin-db.ts` for `coach_outcome_eval_weekly` and decision linkage fields.
- [x] Sub-task 3: Update `/Users/hd/Developer/cortana/tools/fitness/weekly-insights-data.ts` to include the new evaluation result and explanation.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-outcome-eval.test.ts`.

#### Important Planning Notes

- Outcome evaluation must use evidence from athlete-state, decisions, and check-ins rather than vague summary language.
- Keep the score interpretable. The operator should be able to understand why the week scored well or poorly.
- Do not let evaluation logic hide low signal quality. Sparse weeks should score with explicit caveats.

#### Testing

- A high-adherence, good-recovery fixture produces a stronger outcome score than a low-adherence, overreached fixture.
- Sparse or low-quality weeks preserve caveats in the evaluation payload.
- Weekly artifacts can render the evaluation without regressing existing output limits.

---

## Sprint 4 - Integrate With Runtime And Identity

### Vertical 5 - Cron and Identity Integration

**cortana: Wire the operating loop into cron contracts, memory rules, and runtime expectations**

*Dependencies: Depends on V1, V2, V3, V4*

#### Jira

- [x] Sub-task 1: Update `~/.openclaw/cron/jobs.json` or supporting scripts so morning, evening, weekly, and alert jobs align to the new today mission and alert-policy layers.
- [x] Sub-task 2: Update `/Users/hd/Developer/cortana/tools/fitness/specialist-prompts.md` so specialist analyses reference the structured loop artifacts instead of ad hoc raw-provider-only analysis.
- [x] Sub-task 3: Review `/Users/hd/Developer/cortana/identities/spartan/MEMORY.md` and `/Users/hd/Developer/cortana/identities/spartan/SOUL.md` for any stable updates needed after the loop lands.
- [x] Sub-task 4: Run the end-to-end cron contract and fitness test suite.

#### Testing

- Cron contract tests still pass with any new or updated jobs.
- Today mission, evening closure, and weekly evaluation all coexist without contradictory state.
- Identity files remain aligned with runtime behavior and do not promise unsupported capabilities.

---

## Dependency Notes

### V1 and V2 before V3

Alerting depends on having stable daily mission context and structured check-ins; otherwise alerts remain narrow and brittle.

### Training Intelligence before V4

Outcome evaluation needs recommendation targets and structured weekly intelligence to judge whether Spartan’s guidance was appropriate.

### V4 before V5

Runtime integration should happen after today mission, alerting, and evaluation contracts are stable, or cron jobs will churn repeatedly.

---

## Scope Boundaries

### In Scope (This Plan)

- daily mission artifact
- structured check-in parsing
- alert policy and alert logging
- compliance and outcome evaluation
- cron and identity integration

### External Dependencies

- baseline athlete-state and recommendation outputs
- training-intelligence weekly outputs
- current Telegram delivery via `cron-fitness`
- active Spartan session logs under `~/.openclaw/agents/spartan/sessions`

### Integration Points

- reads athlete-state and recommendation tables
- reads and extends `coach_conversation_log` and `coach_decision_log`
- writes `coach_checkin_log`, `coach_alert_log`, and `coach_outcome_eval_weekly`
- integrates with `~/.openclaw/cron/jobs.json`

---

## Realistic Delivery Notes

This epic is operationally sensitive because it changes how Spartan behaves day to day. The safest approach is to keep all decisions structured and logged, preserve concise message contracts, and harden alert dedupe before adding any new proactive surface.

- **Biggest risks:** noisy alerts, brittle natural-language parsing, and cron-contract regressions.
- **Assumptions:** Telegram remains the primary surface, user check-ins stay natural-language first, and deterministic scoring is preferred over opaque “smart” evaluation.
