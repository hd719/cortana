# Implementation Plan - Deterministic Maintenance Jobs

**Document Status:** Draft

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | Huragok |
| Epic | OpenClaw Autonomy: Deterministic Maintenance Jobs |
| Tech Spec | [Tech Spec](../techspec/techspec-deterministic-maintenance-jobs.md) |
| PRD | [PRD](../prd/prd-deterministic-maintenance-jobs.md) |

---

## Dependency Map

| Vertical | Dependencies | Can Start? |
|----------|--------------|------------|
| V1 - Inventory and contract | None | Start now |
| V2 - Command runner and tests | V1 | Start after contract |
| V3 - Pilot migration | V2 | Start after runner tests |
| V4 - Runtime rollout and watch | V3 | Start after pilot smoke |

---

## Recommended Execution Order

```text
Week 1: Inventory, schema contract, command runner, unit tests
Week 2: Pilot 2-3 low-risk jobs, runtime sync, smoke checks
Week 3: Expand to remaining eligible jobs, monitor 14-day watch window
```

---

## Sprint 1 - Contract And Runner

### Vertical 1 - Inventory and contract

**cortana: produce a reviewable list of deterministic jobs and a reversible command-job schema.**

*Dependencies: None*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana/tools/cron/deterministic-job-inventory.ts` to scan `/Users/hd/Developer/cortana/config/cron/jobs.json`.
- Sub-task 2: Classify candidates with include/exclude reason, command, owner, quiet-path rule, timeout, and fallback eligibility.
- Sub-task 3: Add fixture coverage in `/Users/hd/Developer/cortana/tests/cron/deterministic-maintenance-jobs.test.ts`.

#### Testing

- Inventory includes the known candidate jobs from the PRD.
- Judgment-heavy prompts are excluded with reasons.
- Missing command or unclear output contract prevents migration.

### Vertical 2 - Command runner

**cortana: execute one command job without model mediation while preserving alert semantics.**

*Dependencies: V1*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana/tools/cron/command-job-runner.ts`.
- Sub-task 2: Implement timeout, redaction, stdout/stderr cap, exit code capture, event logging, and `NO_REPLY` handling.
- Sub-task 3: Add tests for quiet success, actionable output, non-zero exit, timeout, event logging failure, and `--no-alert`.

#### Testing

- Exact `NO_REPLY` is silent success.
- `NO_REPLY` with extra text is not considered quiet success.
- Actionable output uses Monitor delivery guard in alert mode.
- Timeout returns non-zero with a concise diagnostic.

---

## Sprint 2 - Pilot Migration

### Vertical 3 - Pilot jobs

**cortana/runtime: migrate a small batch and prove source/runtime behavior matches.**

*Dependencies: V2*

#### Jira

- Sub-task 1: Update `/Users/hd/Developer/cortana/config/cron/jobs.json` for 2-3 low-risk jobs, preserving fallback metadata.
- Sub-task 2: Create `/Users/hd/Developer/cortana/tools/cron/smoke-command-jobs.ts` for no-alert local smoke checks.
- Sub-task 3: Update `/Users/hd/Developer/cortana/tools/deploy/sync-runtime-from-cortana.sh` to validate command-job config before sync.

#### Important Planning Notes

- Start with quiet maintenance jobs that already have strong script output contracts.
- Do not migrate trading, summaries, inbox, or research synthesis jobs in this phase.
- Roll back by toggling the job to its fallback definition, not by reverting unrelated cron config.

#### Testing

- `npx tsx tools/cron/smoke-command-jobs.ts --no-alert`
- `/Users/hd/Developer/cortana/tools/deploy/sync-runtime-from-cortana.sh`
- `openclaw cron list`

---

## Sprint 3 - Expansion And Watch

### Vertical 4 - Rollout and measurement

**cortana/runtime: expand migration and watch for missed alerts or noisy output.**

*Dependencies: V3*

#### Jira

- Sub-task 1: Migrate the remaining eligible jobs from the inventory.
- Sub-task 2: Add operator runbook notes to `/Users/hd/Developer/cortana/docs/source/runbook/openclaw-doctor-inspector-runbook.md`.
- Sub-task 3: Record model-turn reduction and alert behavior after rollout.

#### Testing

- Healthy paths send zero Telegram messages.
- Actionable fixture output still sends one Monitor-owned alert.
- Runtime state and `cortana_events` show migrated run evidence.

---

## Dependency Notes

### V1 before V2

The runner contract should be driven by the actual cron inventory so the implementation does not optimize for a fake payload shape.

### V2 before V3

Runtime migration is unsafe until output routing and timeout behavior are covered by tests.

### V3 before V4

The pilot proves OpenClaw runtime compatibility before broader config churn.

---

## Scope Boundaries

### In Scope

- Deterministic maintenance job inventory.
- Command-runner contract and tests.
- Incremental migration with fallback.
- Runtime sync and smoke validation.

### External Dependencies

- OpenClaw cron support for direct command payloads, or wrapper compatibility.
- Existing Telegram delivery guard.
- Cortana DB availability for audit events.

### Integration Points

- `/Users/hd/Developer/cortana/config/cron/jobs.json`
- `/Users/hd/.openclaw/cron/jobs.json`
- `/Users/hd/Developer/cortana/tools/notifications/telegram-delivery-guard.sh`

---

## Realistic Delivery Notes

The smallest credible implementation is one command runner, one inventory tool, and one migrated low-risk job. Expand only after smoke checks pass.

- **Biggest risks:** scheduler payload compatibility, scripts with ambiguous output, accidental alert noise.
- **Assumptions:** `NO_REPLY` remains the quiet contract, Monitor owns actionable maintenance alerts, fallback remains per-job.
