# Implementation Plan - Spartan Health Expansion

**Document Status:** Implemented

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | @hd |
| Epic | Spartan Health Expansion |
| Tech Spec | [Link to Tech Spec](../techspec/techspec-spartan-health-expansion.md) |
| PRD | [Link to PRD](../prd/prd-spartan-health-expansion.md) |

---

## Dependency Map

| Vertical | Dependencies | Can Start? |
|----------|-------------|------------|
| V1 - Export Contract And External-Service Ingest | Core Baseline | Start after baseline |
| V2 - Normalized Health Storage | V1 | Start after V1 |
| V3 - Athlete-State And Body-Composition Integration | V2, Training Intelligence | Start after V2 and training intelligence |
| V4 - Reconciliation And Fallback Logic | V2, V3 | Start after V2, V3 |
| V5 - Validation, Privacy, And Rollout Hardening | V1, V2, V3, V4 | Start after V1-V4 |

---

## Recommended Execution Order

```text
Week 1: V1 (define the export contract and local ingest path)
Week 2: V2 (persist normalized health-source rows)
Week 3: V3 (feed health data into athlete state and body-composition logic)
Week 4: V4 (add source reconciliation and fallback rules)
Week 5: V5 (validate with real exports and harden privacy/freshness behavior)
```

---

## Sprint 1 - Ingest Apple Health Locally

### Vertical 1 - Export Contract and External-Service Ingest

**cortana-external: Add a local Apple Health export contract and service endpoints**

*Dependencies: Depends on Core Baseline*

#### Jira

- [x] Sub-task 1: Add Apple Health config support in `/Users/hd/Developer/cortana-external/apps/external-service/src/config.ts`, including a default local path such as `~/.openclaw/data/apple-health/latest.json`.
- [x] Sub-task 2: Create `/Users/hd/Developer/cortana-external/apps/external-service/src/apple-health/service.ts`, `routes.ts`, and `index.ts`.
- [x] Sub-task 3: Register the new service in `/Users/hd/Developer/cortana-external/apps/external-service/src/app.ts`.
- [x] Sub-task 4: Document the local contract in `/Users/hd/Developer/cortana-external/mjolnir/APPLE_HEALTH_SERVICE.md`.
- [x] Sub-task 5: Add tests in `/Users/hd/Developer/cortana-external/apps/external-service/src/__tests__/apple-health.test.ts`.

#### Testing

- A valid local export file is served successfully.
- Missing files return `unconfigured`, stale files return `degraded`, and invalid files return `unhealthy`.
- The route contract is deterministic and schema-validated.

---

## Sprint 2 - Normalize And Store Health Data

### Vertical 2 - Normalized Health Storage

**cortana: Persist Apple Health-derived daily rows with provenance**

*Dependencies: Depends on V1*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/health-source-db.ts` with schema and upsert helpers for `cortana_fitness_health_source_daily`.
- [x] Sub-task 2: Add an ingest script or helper that reads `http://127.0.0.1:3033/apple-health/data` and normalizes rows for each supported metric.
- [x] Sub-task 3: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-health-source-db.test.ts`.

#### Testing

- One source day can produce multiple metric rows with provenance intact.
- Re-ingesting the same export updates freshness without duplicating logical rows.
- Unknown metrics are ignored or flagged predictably rather than causing schema drift.

---

## Sprint 3 - Use Health Data In Coaching

### Vertical 3 - Athlete-State and Body-Composition Integration

**cortana: Feed Apple Health into athlete state, body-weight trend, and phase logic**

*Dependencies: Depends on V2 and Training Intelligence*

#### Jira

- [x] Sub-task 1: Create `/Users/hd/Developer/cortana/tools/fitness/body-composition-engine.ts` with preferred-source selection and weekly body-weight trend helpers.
- [x] Sub-task 2: Update `/Users/hd/Developer/cortana/tools/fitness/athlete-state-data.ts` and `/Users/hd/Developer/cortana/tools/fitness/athlete-state-db.ts` for new health-context fields.
- [x] Sub-task 3: Update `/Users/hd/Developer/cortana/tools/fitness/goal-mode.ts` so cut and gain pace can use real weekly weight change when confidence is adequate.
- [x] Sub-task 4: Add tests in `/Users/hd/Developer/cortana/tests/cron/fitness-body-composition-engine.test.ts` and extend athlete-state tests.

#### Important Planning Notes

- Apple Health should become authoritative per metric only when freshness and confidence are sufficient.
- The system must not overwrite trustworthy existing fields with stale or low-confidence health data.
- Weight-trend logic should preserve explicit confidence and quality flags.

#### Testing

- A recent Apple Health weight series yields a usable weekly weight-change signal.
- Sparse or stale data lowers confidence and preserves fallback behavior.
- Athlete-state rows show both selected values and source provenance.

---

## Sprint 4 - Reconcile Multiple Sources Safely

### Vertical 4 - Reconciliation and Fallback Logic

**cortana: Make preferred-source logic explicit and safe**

*Dependencies: Depends on V2, V3*

#### Jira

- [x] Sub-task 1: Implement preferred-source rules in `/Users/hd/Developer/cortana/tools/fitness/body-composition-engine.ts` for body weight, steps, and energy fields.
- [x] Sub-task 2: Update `/Users/hd/Developer/cortana/tools/fitness/monthly-overview-data.ts` and weekly reporting code to explain when health-derived data is unavailable or low confidence.
- [x] Sub-task 3: Add tests for source switching, stale fallback, and conflict handling.

#### Testing

- Apple Health wins for body weight when fresh and valid.
- The system falls back safely when Apple Health is missing or stale.
- Reporting distinguishes low confidence from missing data.

---

## Sprint 5 - Harden And Validate

### Vertical 5 - Validation, Privacy, and Rollout Hardening

**cortana + cortana-external: Validate the local export workflow and keep health data local and explicit**

*Dependencies: Depends on V1, V2, V3, V4*

#### Jira

- [x] Sub-task 1: Run `vitest` in both repos for all new Apple Health coverage.
- [x] Sub-task 2: Validate real local export files against the service and ingest pipeline.
  Validation now covers importing a local export file through the Apple Health service, confirming `healthy` service status, ingesting normalized rows into `cortana_fitness_health_source_daily`, and verifying athlete-state hydration/body-composition fields consume the imported metrics.
- [x] Sub-task 3: Confirm sensitive health data remains in local file paths, local service responses, and local DB rows only.
- [x] Sub-task 4: Add any small operational docs needed for exporter setup and troubleshooting.

#### Testing

- Real local exports parse cleanly.
- Freshness checks work against real timestamps.
- The coaching stack remains functional when Apple Health is absent.

---

## Dependency Notes

### V1 before V2

Normalized storage depends on a stable ingest contract and local service path first.

### V2 before V3

Athlete-state integration should consume normalized daily rows, not raw export files.

### Training Intelligence before V3

Body-weight trend only becomes strategically useful once phase and recommendation logic can consume it coherently.

### V3 before V4

Preferred-source reconciliation is easier to harden after the consumer fields and body-composition logic already exist.

---

## Scope Boundaries

### In Scope (This Plan)

- local Apple Health export contract
- external-service Apple Health ingest
- normalized daily health rows
- athlete-state integration for body weight, steps, and activity energy
- explicit source reconciliation and fallback behavior

### External Dependencies

- a local Apple Health export mechanism
- baseline athlete-state and training-intelligence logic
- continued availability of the local external service

### Integration Points

- reads local export file through `cortana-external`
- writes `cortana_fitness_health_source_daily`
- updates `cortana_fitness_athlete_state_daily`
- feeds body-composition-aware weekly and monthly logic

---

## Realistic Delivery Notes

This epic should stay brutally practical. The value is not in a fancy Apple integration story; it is in getting trusted body weight and activity context into Spartan without destabilizing the existing stack.

- **Biggest risks:** exporter inconsistency, stale files, and unclear preferred-source rules.
- **Assumptions:** the first implementation is file-based, local, and read-only; no native HealthKit app work is required to get useful value.
