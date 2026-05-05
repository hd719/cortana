# Technical Specification - Deterministic Maintenance Jobs

**Document Status:** In Implementation

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | Huragok |
| Epic | OpenClaw Autonomy: Deterministic Maintenance Jobs |

---

## Development Overview

This change moves deterministic OpenClaw maintenance cron jobs from model-mediated `agentTurn` prompts to script-first execution. A migrated job executes a fixed command, records exit code/stdout/stderr/duration, treats exact `NO_REPLY` as silent success, and escalates only actionable output through the existing Monitor-owned alert path.

Affected repos and runtime surfaces:

- `cortana`: job inventory, runner contract, cron config migration, tests, runtime sync.
- `~/.openclaw`: deployed cron config and live cron state after sync.
- OpenClaw scheduler: direct command support is preferred, but the first implementation can use a command-runner script wrapper if the runtime does not yet expose a native command payload.

Implementation decision for open PRD questions:

- Direct command cron payload: pin the tracked `cortana` contract to the existing cron job envelope and put the new execution mode under `payload.kind=command`. Do not introduce top-level `type=command` jobs. If live OpenClaw does not accept `payload.kind=command` by implementation time, v1 must deploy wrapper-mode `agentTurn` entries and preserve the canonical command spec in metadata until native support exists.
- Run evidence storage: write both OpenClaw cron state and `cortana_events` where available. Cron state remains the scheduler-visible status; `cortana_events` is the audit/autonomy surface.
- Actionable output delivery: use `/Users/hd/Developer/cortana/tools/notifications/telegram-delivery-guard.sh` for v1 so account routing stays under the existing Monitor contract. A native runtime sender can be added later behind the same interface.

Intentionally unchanged:

- Judgment-heavy cron jobs stay `agentTurn`.
- Telegram account routing and Monitor ownership do not change.
- Runtime deployment still goes through `/Users/hd/Developer/cortana/tools/deploy/sync-runtime-from-cortana.sh`.

---

## Data Storage Changes

### Database Changes

#### UPDATE `cortana_events`

No required schema change for v1. Command-runner results should insert normal event rows when the database is reachable.

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| Existing | `type` | text | Use values such as `cron.command.success`, `cron.command.actionable`, `cron.command.timeout`, `cron.command.error`. |
| Existing | `severity` | text | `info` for verified quiet success, `warning` or `critical` for actionable output. |
| Existing | `message` | text | Short operator-readable summary. |
| Existing | `metadata` | json/jsonb | Include job id, command id, exit code, duration, stdout/stderr digest, timeout flag, and migration mode. |

Notes:

- Raw stdout/stderr should be capped before database insert.
- Secrets must be redacted before persistence.

### File / Runtime State Changes

#### UPDATE `config/cron/jobs.json`

Add a reversible command-runner representation for eligible jobs. Preserve the legacy `agentTurn` definition in metadata or adjacent disabled config until the rollout is proven.

Canonical command job shape before runtime adaptation:

```json
{
  "id": "main-bootstrap-refresh",
  "agentId": "cron-maintenance",
  "name": "Main Bootstrap Refresh",
  "enabled": true,
  "schedule": {
    "kind": "cron",
    "expr": "*/30 * * * *",
    "tz": "America/New_York"
  },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "command",
    "command": "npx",
    "args": ["tsx", "tools/context/refresh-main-bootstrap.ts"],
    "cwd": "/Users/hd/Developer/cortana",
    "timeoutMs": 120000,
    "quietSuccess": "NO_REPLY",
    "owner": "monitor",
    "fallback": {
      "kind": "agentTurn",
      "enabled": true,
      "message": "Run the canonical command-runner fallback for main-bootstrap-refresh."
    }
  }
}
```

Runtime adaptation rules:

- Source validation must reject command-job config unless the payload is nested under `payload.kind=command`.
- Runtime sync must prove native `payload.kind=command` support before deploying it to `~/.openclaw`.
- If native support is absent, generate wrapper scripts under `tools/cron/command-jobs/` and deploy ordinary `payload.kind=agentTurn` cron entries that call the wrapper. The wrapper entry must include `metadata.commandJobSpec` so rollback and later native migration are deterministic.
- Smoke tests must compare source config and live `~/.openclaw/cron/jobs.json` after sync. A code diff alone is not proof of migration.

---

## Infrastructure Changes

### SNS Topic Changes

None.

### SQS Queue Changes

None.

### Cache Changes

No cache is required. Runner state may use a small local JSON report for smoke testing, but cron state and events are the durable sources.

### S3 Changes

None.

### Secrets Changes

None. Existing command environments must continue to source secrets through the current runtime environment.

### Network/Security Changes

None. Commands execute locally on the Mac mini. Output redaction is required before alerts, events, or logs.

---

## Behavior Changes

- Eligible maintenance jobs run without an LLM turn on the healthy path.
- Exact stdout `NO_REPLY` plus exit code `0` is silent success.
- Non-empty output other than exact `NO_REPLY`, non-zero exit, timeout, or runner failure becomes actionable according to job severity.
- A migrated job can fall back to the legacy `agentTurn` definition per job.
- Healthy migrated runs should reduce model usage, latency, and prompt drift risk.

Safe degradation:

- If the command runner cannot classify output, it exits non-zero with a short actionable diagnostic.
- If database logging fails, the runner still records scheduler-visible exit status and emits actionable output when needed.
- If OpenClaw direct command support is absent, the wrapper mode keeps the same output contract.

---

## Application/Script Changes

New files:

- `/Users/hd/Developer/cortana/tools/cron/deterministic-job-inventory.ts`
  - Reads `config/cron/jobs.json`, identifies deterministic `agentTurn` jobs, and writes an inventory with include/exclude reasons.
- `/Users/hd/Developer/cortana/tools/cron/command-job-runner.ts`
  - Executes a configured command, captures result metadata, applies `NO_REPLY` semantics, logs events, and prints only actionable output.
- `/Users/hd/Developer/cortana/tools/cron/smoke-command-jobs.ts`
  - Dry-runs migrated jobs in no-alert mode and reports readiness.
- `/Users/hd/Developer/cortana/tests/cron/deterministic-maintenance-jobs.test.ts`
  - Covers inventory classification, output routing, timeout handling, fallback metadata, and literal `NO_REPLY`.

Updated files:

- `/Users/hd/Developer/cortana/config/cron/jobs.json`
  - Migrates selected candidate jobs incrementally.
- `/Users/hd/Developer/cortana/tools/deploy/sync-runtime-from-cortana.sh`
  - Optionally validates migrated command-job schema before syncing runtime config.
- `/Users/hd/Developer/cortana/tests/cron/sync-cron-to-runtime.test.ts`
  - Adds coverage for command-job fields and fallback preservation.
- `/Users/hd/Developer/cortana/docs/source/runbook/openclaw-doctor-inspector-runbook.md`
  - Adds operator guidance for command-job smoke checks and rollback.

Candidate first jobs:

- Main Bootstrap Refresh
- Subagent Reliability Reaper
- Session Lifecycle Policy Check
- Ops Routing Drift Check
- Runtime vs Repo Drift Monitor
- Browser CDP Watchdog
- OpenAI Auth Preflight/Sweep

LLM-agnostic implementation rule:

- Output classification, timeout thresholds, fallback behavior, owner lane, and severity mapping must live in typed code/config, not only prompt prose.

---

## API Changes

No external HTTP API changes.

### NEW Command Runner Interface

| Field | Value |
|-------|-------|
| **Interface** | `npx tsx tools/cron/command-job-runner.ts --job-id <id> [--no-alert]` |
| **Description** | Executes one deterministic cron command using the tracked job contract. |
| **Additional Notes** | Intended for OpenClaw cron and local smoke checks. |

| Field | Detail |
|-------|--------|
| **Authentication** | Local machine execution only. |
| **Input** | `--job-id`, optional `--no-alert`, optional `--runtime-state-path`. |
| **Success Response** | Prints exact `NO_REPLY` for quiet success or nothing if scheduler treats empty stdout as success. |
| **Error Responses** | Non-zero exit and concise actionable output for timeout, command error, or delivery failure. |

---

## Process Changes

- Run inventory before migration and commit the generated review artifact or summary.
- Migrate jobs in small batches with per-job rollback.
- Deploy with `/Users/hd/Developer/cortana/tools/deploy/sync-runtime-from-cortana.sh`.
- Verify with command-job smoke checks, `openclaw cron list`, and relevant live health commands.
- Keep migrated jobs in watch mode for 14 days before deleting legacy fallback metadata.

---

## Test Plan

Unit and integration coverage:

- `/Users/hd/Developer/cortana/tests/cron/deterministic-maintenance-jobs.test.ts`
- `/Users/hd/Developer/cortana/tests/cron/sync-cron-to-runtime.test.ts`
- `/Users/hd/Developer/cortana/tests/notifications/telegram-delivery-guard.test.ts`

Manual or live validation:

- `npx tsx tools/cron/deterministic-job-inventory.ts`
- `npx tsx tools/cron/smoke-command-jobs.ts --no-alert`
- `openclaw cron list`
- `npx tsx tools/alerting/check-cron-delivery.ts`

Success means:

- Migrated healthy jobs produce no Telegram messages.
- Actionable fixture output routes as Monitor-owned alert text.
- Timeout and non-zero exit paths are visible and auditable.
- Rollback to `agentTurn` works for one selected job.

---

## Risks / Follow-ups

- OpenClaw direct command cron support may require wrapper mode in v1.
- Some prompts may look deterministic but encode subtle judgment; those should remain excluded.
- Scripts that currently rely on model interpretation may need small output contract fixes before migration.
