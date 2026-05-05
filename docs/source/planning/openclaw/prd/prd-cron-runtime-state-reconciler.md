# Product Requirements Document (PRD) - Cron Runtime State Reconciler

**Document Status:** Draft

## Team

| Role | Assignee |
|------|----------|
| Primary Owner | Huragok |
| Epic | OpenClaw Autonomy: Cron Runtime State Reconciler |

---

## Problem / Opportunity

Operator surfaces can disagree about whether cron jobs are healthy. `openclaw cron list` may show an error while tracked job config and watchdog/autonomy state indicate recovery. This creates false operational concern and makes autonomy less trustworthy.

The opportunity is to build a deterministic reconciler that compares live cron state, tracked config, recent run evidence, and watchdog/autonomy conclusions, then classifies stale history separately from active failure.

---

## Insights

- The system already treats stale history as a common incident class.
- Docs repeatedly warn that `consecutiveErrors` or old `lastStatus=error` is not proof of active failure.
- Fresh runtime proof should override stale historical state, but only with clear evidence.
- Healthy paths should stay quiet; stale error cleanup should be auditable.

Problems this project is not intended to solve:

- Hiding real cron failures.
- Changing cron schedules.
- Replacing watchdog or autonomy-remediation checks.

---

## Development Overview

Implementation belongs in `cortana`.

The reconciler should:

- read `~/.openclaw/cron/jobs.json`
- read `config/cron/jobs.json`
- query recent cron/session/event evidence where available
- classify each job as `healthy`, `active_failure`, `stale_error_state`, `unknown`, or `needs_human`
- optionally repair stale error metadata when verified safe
- emit concise operator output only when action is needed

Mission Control can later consume this classification, but the first version should be CLI/script driven.

---

## Success Metrics

- `0` known-recovered jobs continue to appear as active failures after reconciliation.
- Real active failures still produce non-zero/actionable output.
- Reconciler output identifies evidence source for every repair decision.
- Repairs are logged to `cortana_events`.
- No silent repair occurs without fresh success evidence.
- Apply-mode repair is verified against live gateway-visible state after scheduler reload/restart.

---

## Assumptions

- Runtime cron state remains JSON-backed under `~/.openclaw/cron/jobs.json`, but the gateway scheduler may also hold in-memory state that must be reloaded or restarted after direct file repair.
- Recent success evidence can be found in cron state, OpenClaw sessions, or `cortana_events`.
- Some jobs may lack enough evidence and should remain `unknown`, not auto-repaired.
- Source config remains canonical for intended schedule/prompt shape.

---

## Out of Scope

- Running failed jobs automatically beyond existing autonomy policy.
- Rewriting job prompts.
- Changing OpenClaw scheduler internals unless required for safe state repair.
- Deleting historical run logs.

---

## High Level Requirements

| Requirement | Description | Notes |
|-------------|-------------|-------|
| [Requirement 1 - State aggregation](#requirement-1---state-aggregation) | Gather runtime, source, session, and event evidence. | Must tolerate missing fields. |
| [Requirement 2 - Classification](#requirement-2---classification) | Produce explicit health categories with evidence. | Avoid binary healthy/unhealthy only. |
| [Requirement 3 - Safe repair](#requirement-3---safe-repair) | Clear stale error state only when proof exists. | Dry-run by default. |
| [Requirement 4 - Alert contract](#requirement-4---alert-contract) | Report only active/actionable failures. | `NO_REPLY` when clean. |

---

## Detailed User Stories

### Glossary

| Term | Meaning |
|------|---------|
| Stale error state | Historical error metadata that no longer reflects current behavior. |
| Active failure | A fresh run or probe proves the job is currently failing. |
| Repair | Updating runtime state metadata to reflect verified recovery. |

---

### Requirement 1 - State Aggregation

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an operator, I want one command to compare source cron config and runtime cron state. | Include changed schedule/payload detection. |
| Accepted | As Monitor, I want recent run evidence considered before alerting. | Sessions/events can disprove stale error history. |

---

### Requirement 2 - Classification

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an operator, I want each job classified with the evidence that drove the result. | Example: `stale_error_state: latest run ok 5m ago`. |
| Accepted | As a developer, I want ambiguous jobs left as `unknown` rather than auto-repaired. | Conservative default. |

---

### Requirement 3 - Safe Repair

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an operator, I want stale error metadata repaired only when a fresh successful run exists. | No repair from hope. |
| Accepted | As a developer, I want `--dry-run` and `--apply` modes. | Automation can start read-only. |
| Accepted | As Monitor, I want every repair logged with before/after state. | Use `cortana_events`. |
| Accepted | As an operator, I want apply mode to reload/restart the scheduler and verify live state before claiming repair. | File mutation alone is not fixed. |

---

### Requirement 4 - Alert Contract

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Hamel, I want only active cron failures to page me. | Stale repairs should stay quiet or digest-only. |
| Accepted | As Monitor, I want clean output to be exactly `NO_REPLY`. | Compatible with existing quiet paths. |

---

## Appendix

### Initial Commands

Proposed CLI shapes:

```bash
npx tsx tools/monitoring/cron-state-reconciler.ts --dry-run
npx tsx tools/monitoring/cron-state-reconciler.ts --apply
```

### Implementation Decisions

- Prefer a native OpenClaw CLI/RPC repair command. If none exists, direct JSON repair must use backup, lock, atomic write, gateway scheduler reload/restart, and post-reload verification.
- Success evidence freshness is job-specific: `max(2 * schedule interval, 30 minutes)`, capped at `24 hours` for daily jobs, and must be newer than the latest known error.
- Run dry-run after post-merge runtime sync and daily/attention cron health workflows. Do not run on every heartbeat unless the system is already in `attention`.
