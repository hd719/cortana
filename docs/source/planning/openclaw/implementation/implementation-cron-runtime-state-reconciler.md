# Implementation Plan - Cron Runtime State Reconciler

**Document Status:** Complete

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | Huragok |
| Epic | OpenClaw Autonomy: Cron Runtime State Reconciler |
| Tech Spec | [Tech Spec](../techspec/techspec-cron-runtime-state-reconciler.md) |
| PRD | [PRD](../prd/prd-cron-runtime-state-reconciler.md) |

---

## Dependency Map

**Implementation status:** Complete. Evidence loading, deterministic classification, dry-run/report output, apply-mode repair, backup/reload verification, event logging, focused tests, runbook instructions, post-merge dry-run reporting, daily cron digest summary, and delivery-monitor classification filtering are implemented.

| Vertical | Dependencies | Can Start? |
|----------|--------------|------------|
| V1 - Evidence model | None | Complete |
| V2 - Classification engine | V1 | Complete |
| V3 - Safe repair mode | V2 | Complete |
| V4 - Workflow integration | V3 | Complete |

---

## Recommended Execution Order

```text
Week 1: Evidence readers and classification fixtures
Week 2: Dry-run CLI, JSON report, active/stale/unknown behavior
Week 3: Apply-mode repair, post-merge/digest integration, runbook update
```

---

## Sprint 1 - Evidence And Classification

### Vertical 1 - Evidence model

**cortana: normalize source config, runtime cron state, sessions, and event evidence.**

*Dependencies: None*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana/tools/monitoring/cron-state-evidence.ts`.
- Sub-task 2: Add fixtures for runtime state with stale errors, fresh success, fresh failure, and missing evidence.
- Sub-task 3: Add tests in `/Users/hd/Developer/cortana/tests/monitoring/cron-state-reconciler.test.ts`.

#### Testing

- Runtime JSON parsing tolerates missing optional fields.
- Source config mismatch is reported as evidence, not ignored.
- Freshness windows derive from schedule interval with the 30-minute floor and 24-hour cap.

### Vertical 2 - Classification engine

**cortana: produce deterministic job classifications with evidence strings.**

*Dependencies: V1*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana/tools/monitoring/cron-state-reconciler.ts` with dry-run default.
- Sub-task 2: Implement `healthy`, `active_failure`, `stale_error_state`, `unknown`, and `needs_human`.
- Sub-task 3: Write `/Users/hd/.openclaw/reports/cron-state-reconciler/latest.json` when requested.

#### Testing

- Stale error requires newer success than latest error.
- Active failure returns non-zero/actionable output.
- Clean state emits exact `NO_REPLY`.
- Unknown never repairs.

---

## Sprint 2 - Repair And Audit

### Vertical 3 - Safe repair mode

**cortana/runtime: repair only stale runtime metadata with backup and audit trail.**

*Dependencies: V2*

#### Jira

- Sub-task 1: Add `--apply` mode to `/Users/hd/Developer/cortana/tools/monitoring/cron-state-reconciler.ts`.
- Sub-task 2: Implement backup, validation, file lock, atomic write, scheduler reload/restart, post-reload verification, and before/after event logging.
- Sub-task 3: Add tests for invalid JSON, write failure, non-repairable fields, and DB logging behavior.

#### Important Planning Notes

- If OpenClaw exposes a repair CLI by implementation time, use that adapter instead of direct file mutation.
- Apply mode should change only stale status metadata, not schedule, prompt, command, or enabled state.
- Direct JSON mutation is incomplete until the gateway scheduler has reloaded and the reconciler has re-read live cron state to verify the repaired metadata is visible.
- Stale repair should stay quiet unless the repair itself fails.

#### Testing

- Apply mode creates a backup before write.
- Only repairable fields change.
- Reload/restart failure exits non-zero and does not claim repair success.
- Post-reload live-state verification is required before emitting repaired status.
- Event metadata includes evidence source and before/after state.

---

## Sprint 3 - Operator Workflow

### Vertical 4 - Workflow integration

**cortana: make reconciliation part of post-merge and daily cron health workflows.**

*Dependencies: V3*

#### Jira

- Sub-task 1: Update `/Users/hd/Developer/cortana/tools/repo/post-merge-sync.sh` to run dry-run reconciliation after runtime sync.
- Sub-task 2: Update `/Users/hd/Developer/cortana/tools/monitoring/daily-cron-digest.ts` and `/Users/hd/Developer/cortana/tools/alerting/check-cron-delivery.ts` to consume classifications.
- Sub-task 3: Update `/Users/hd/Developer/cortana/docs/source/runbook/openclaw-doctor-inspector-runbook.md`.

#### Testing

- Post-merge dry-run prints `NO_REPLY` when clean.
- Daily digest labels stale error state separately from active failure.
- Apply-mode instructions are reproducible from the runbook.

---

## Dependency Notes

### V1 before V2

Classification quality depends on normalized evidence. Building classification first would recreate stale-history bugs in code.

### V2 before V3

Dry-run classification must be trusted before any runtime-owned JSON is mutated.

### V3 before V4

Workflow integration should not invite operators to use apply mode until repair tests and backup behavior exist.

---

## Scope Boundaries

### In Scope

- Cron state aggregation.
- Stale-vs-active classification.
- Guarded repair of stale metadata.
- Post-merge and daily digest integration.

### External Dependencies

- Runtime cron state under `~/.openclaw/cron/jobs.json`.
- OpenClaw gateway reload/restart support when native repair is unavailable.
- Cortana DB event logging.
- OpenClaw CLI repair support if available.

### Integration Points

- `/Users/hd/Developer/cortana/config/cron/jobs.json`
- `/Users/hd/.openclaw/cron/jobs.json`
- `/Users/hd/Developer/cortana/tools/repo/post-merge-sync.sh`

---

## Realistic Delivery Notes

The MVP is dry-run classification plus a JSON report. Apply-mode repair can ship after classification is trusted.

- **Biggest risks:** runtime state shape drift, incomplete evidence, unsafe direct mutation, file truth diverging from the gateway scheduler's in-memory state.
- **Assumptions:** source config is canonical for intended jobs, success after latest error is required for repair, clean output remains `NO_REPLY`.
