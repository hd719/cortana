# Technical Specification - Cron Runtime State Reconciler

**Document Status:** Draft

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | Huragok |
| Epic | OpenClaw Autonomy: Cron Runtime State Reconciler |

---

## Development Overview

This change adds a deterministic reconciler that compares tracked cron config, live OpenClaw cron state, recent success/failure evidence, and autonomy/watchdog conclusions. It classifies stale historical errors separately from active failures and can repair stale runtime metadata only when fresh recovery proof exists.

Implementation belongs in `cortana`. Mission Control can consume the classification later, but v1 is CLI/script driven.

Implementation decision for open PRD questions:

- Runtime mutation path: prefer an OpenClaw CLI/RPC repair command if one exists by implementation time because the gateway scheduler owns live cron state. If not, v1 may perform guarded JSON repair of `~/.openclaw/cron/jobs.json` only with backup, schema validation, file locking, atomic write, explicit scheduler reload/restart, and post-reload verification. All mutation stays behind `--apply`; default mode is dry-run.
- Evidence freshness: use job-specific freshness. Required freshness is `max(2 * schedule interval, 30 minutes)`, capped at `24 hours` for daily jobs. Repair also requires successful evidence newer than the latest known error.
- Run cadence: run after post-merge runtime sync and in daily/attention cron health workflows. Do not run on every heartbeat unless the system is already in `attention`.

---

## Data Storage Changes

### Database Changes

#### UPDATE `cortana_events`

No required schema change.

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| Existing | `type` | text | Use `cron.reconciler.classified`, `cron.reconciler.repaired`, `cron.reconciler.active_failure`, `cron.reconciler.unknown`. |
| Existing | `severity` | text | `info` for verified stale repair, `warning` for unknown/needs human, `critical` for active critical failure. |
| Existing | `metadata` | json/jsonb | Store job id, classification, evidence source, before/after runtime status, freshness window, and apply mode. |

### File / Runtime State Changes

#### READ `~/.openclaw/cron/jobs.json`

Live cron state remains runtime-owned. The reconciler reads this file in dry-run mode and may repair stale status metadata in apply mode only through the mutation contract below.

Mutation contract:

- Native OpenClaw repair/reload command wins when available.
- Direct JSON mutation is allowed only while holding a reconciler lock and after writing a timestamped backup.
- Direct JSON mutation must change only stale status metadata such as `lastStatus`, `lastRunStatus`, `consecutiveErrors`, stale `runningAtMs`, or equivalent scheduler status fields. It must never change schedule, enabled state, payload, delivery, prompt, command, or owner.
- After direct mutation, the reconciler must trigger a gateway scheduler reload or restart. If no bounded reload API exists, the runbook path is `openclaw gateway restart`.
- After reload/restart, the reconciler must re-read live cron state and confirm the intended repaired metadata is visible. If verification fails, apply mode exits non-zero and reports the mismatch.
- The report must include whether the repair used `native`, `json_plus_reload`, or `dry_run` mode.

#### READ `config/cron/jobs.json`

Tracked config remains the source for intended job ids, schedules, owners, and payload shape.

#### NEW optional report artifact

- `/Users/hd/.openclaw/reports/cron-state-reconciler/latest.json`
  - Last classification payload for Mission Control or operator inspection.

Report shape:

```json
{
  "generatedAt": "2026-05-03T00:00:00.000Z",
  "mode": "dry-run",
  "jobs": [
    {
      "id": "main-bootstrap-refresh",
      "classification": "stale_error_state",
      "evidence": "latest_success_after_error",
      "lastRuntimeStatus": "error",
      "freshUntil": "2026-05-03T00:30:00.000Z",
      "repairable": true,
      "repairMode": "json_plus_reload",
      "requiresSchedulerReload": true,
      "reloadVerified": true
    }
  ]
}
```

---

## Infrastructure Changes

### SNS Topic Changes

None.

### SQS Queue Changes

None.

### Cache Changes

The optional report artifact is a short-lived local cache. It should include `generatedAt` and should not be treated as fresh after 30 minutes unless a caller explicitly accepts stale data.

### S3 Changes

None.

### Secrets Changes

None.

### Network/Security Changes

None. The reconciler is local-only and must not print secrets from cron payloads.

---

## Behavior Changes

- `lastStatus=error` or `consecutiveErrors>0` stops being treated as proof of active failure when newer success evidence exists.
- Active failures remain actionable and produce non-zero output.
- Ambiguous jobs become `unknown`, not silently healthy.
- Verified stale repairs are logged but do not page Hamel.
- Clean output is exactly `NO_REPLY`.

Safe degradation:

- Missing runtime state produces `unknown` or `needs_human`, never repair.
- Invalid JSON aborts apply mode before writing and leaves the original file untouched.
- Scheduler reload/restart failure leaves the backup in place and reports `unknown`, not repaired.
- Database logging failure does not block a dry-run report, but apply mode should include a warning.

---

## Application/Script Changes

New files:

- `/Users/hd/Developer/cortana/tools/monitoring/cron-state-reconciler.ts`
  - Aggregates state, classifies jobs, emits `NO_REPLY` when clean, and repairs stale metadata with `--apply`.
- `/Users/hd/Developer/cortana/tools/monitoring/cron-state-evidence.ts`
  - Shared evidence collectors for runtime cron JSON, source config, sessions, events, and optional command-runner reports.
- `/Users/hd/Developer/cortana/tests/monitoring/cron-state-reconciler.test.ts`
  - Covers classification and repair safety.

Updated files:

- `/Users/hd/Developer/cortana/tools/repo/post-merge-sync.sh`
  - Optionally runs reconciler dry-run after runtime sync and prints actionable output.
- `/Users/hd/Developer/cortana/tools/monitoring/daily-cron-digest.ts`
  - Includes stale-vs-active classifications in daily cron health digest.
- `/Users/hd/Developer/cortana/tools/alerting/check-cron-delivery.ts`
  - Can use reconciler classifications to avoid stale-history alerts.
- `/Users/hd/Developer/cortana/docs/source/doctrine/heartbeat-ops.md`
  - Documents stale cron history as a distinct incident class.
- `/Users/hd/Developer/cortana/docs/source/runbook/openclaw-doctor-inspector-runbook.md`
  - Adds repair workflow and apply-mode guardrails.

LLM-agnostic implementation rule:

- Classification thresholds, evidence precedence, and repair eligibility must be typed constants with fixture tests.

---

## API Changes

No HTTP API changes.

### NEW Cron Reconciler CLI

| Field | Value |
|-------|-------|
| **Interface** | `npx tsx tools/monitoring/cron-state-reconciler.ts --dry-run|--apply [--json]` |
| **Description** | Classifies live cron state and optionally repairs stale runtime metadata. |
| **Additional Notes** | Dry-run is the default. Apply mode requires fresh success evidence. |

| Field | Detail |
|-------|--------|
| **Authentication** | Local operator/runtime execution only. |
| **Input** | Source config path, runtime cron path, optional report path, dry-run/apply mode. |
| **Success Response** | `NO_REPLY` when clean; JSON payload with `--json`. |
| **Error Responses** | Non-zero for active failures, invalid runtime state, unsafe repair, or write failure. |

---

## Process Changes

- Add a post-merge dry-run reconciliation step after runtime sync.
- Run apply mode manually or from a bounded maintenance job after the dry-run result is trusted.
- Store before/after metadata for every repair.
- Treat `unknown` as a follow-up classification, not a false success.

---

## Test Plan

Unit and integration coverage:

- `/Users/hd/Developer/cortana/tests/monitoring/cron-state-reconciler.test.ts`
- `/Users/hd/Developer/cortana/tests/lib/runtime-cron-jobs.test.ts`
- `/Users/hd/Developer/cortana/tests/alerting/check-cron-delivery.test.ts`

Manual or live validation:

- `npx tsx tools/monitoring/cron-state-reconciler.ts --dry-run --json`
- `npx tsx tools/monitoring/cron-state-reconciler.ts --apply --json`
- `openclaw cron list`
- `npx tsx tools/monitoring/daily-cron-digest.ts`

Success means:

- Recovered jobs with stale error metadata classify as `stale_error_state`.
- Jobs with fresh errors classify as `active_failure`.
- Ambiguous jobs classify as `unknown`.
- Apply mode creates a backup, writes atomically, reloads/restarts the scheduler when needed, verifies live state after reload, logs an event, and changes only repairable fields.

---

## Risks / Follow-ups

- Runtime cron JSON shape may change across OpenClaw versions.
- Session/event evidence may be incomplete for older jobs.
- Repairing runtime-owned state is inherently sensitive; native OpenClaw CLI support would reduce this risk.
- Direct JSON repair can diverge from gateway in-memory state unless reload/restart and verification are mandatory.
