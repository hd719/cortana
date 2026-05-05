# Technical Specification - Human-Required Action Queue

**Document Status:** In Implementation

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | Monitor |
| Epic | OpenClaw Autonomy: Human-Required Action Queue |

---

## Development Overview

This change creates a durable queue for blockers that require Hamel to act outside autonomous authority. Known manual blockers are deduped, visible in Mission Control/autonomy summaries, and no longer produce repeated identical watchdog alerts while unchanged.

Implementation spans:

- `cortana`: queue schema, writer library, classification taxonomy, alert suppression, verification/closure.
- `cortana-external`: Mission Control read surface and later manual close UI.

Implementation decision for open PRD questions:

- Storage: use a new `cortana_human_required_actions` table, not `cortana_tasks`. These records have different dedupe, evidence, authority, and verification semantics. Items can link to `cortana_tasks` later.
- Mission Control v1: read-only display first. Manual close is available through a CLI in v1; Mission Control mutation can be v2 unless needed for operator ergonomics.
- Reminder cadence: send one immediate state-change alert for new or materially changed items, include non-critical open items in a daily digest, and escalate family-critical items according to their lane threshold. Do not send repeated identical alerts. "Materially changed" must be decided by typed fields, not prompt judgment.

---

## Data Storage Changes

### Database Changes

#### NEW `cortana_human_required_actions`

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK | `id` | BIGSERIAL | Internal id. |
| UNIQUE partial/open | `fingerprint` | TEXT | Stable dedupe key for one blocker. |
| NOT NULL | `system` | TEXT | `apple_health`, `schwab`, `google_oauth`, `browser_session`, etc. |
| NOT NULL | `category` | TEXT | `human_auth`, `human_permission`, `human_setup`, `human_portal`, `human_browser`. |
| NOT NULL | `owner_lane` | TEXT | Usually `monitor`; may be `spartan`, `oracle`, etc. |
| NOT NULL | `severity` | TEXT | `info`, `warning`, `critical`. |
| NOT NULL | `status` | TEXT | `open`, `verified`, `resolved`, `ignored`, `expired`. |
| NOT NULL | `summary` | TEXT | Short operator-facing label. |
| NOT NULL | `required_action` | TEXT | Human-readable next step. |
| NULL | `verification_key` | TEXT | Allowlisted read-only verification id if available. |
| NOT NULL DEFAULT '{}' | `verification_args` | JSONB | Typed parameters for the allowlisted verification id. |
| NOT NULL DEFAULT '{}' | `evidence` | JSONB | Redacted evidence. |
| NOT NULL DEFAULT '{}' | `metadata` | JSONB | Source-specific context; no secrets. |
| NOT NULL DEFAULT 1 | `detection_count` | INTEGER | Number of matching detections. |
| NOT NULL DEFAULT 0 | `alert_count` | INTEGER | Number of alerts sent. |
| NOT NULL | `first_seen_at` | TIMESTAMPTZ | First detection. |
| NOT NULL | `last_seen_at` | TIMESTAMPTZ | Latest matching detection. |
| NULL | `next_remind_at` | TIMESTAMPTZ | Earliest allowed reminder. |
| NULL | `due_at` | TIMESTAMPTZ | Escalation target. |
| NULL | `verified_at` | TIMESTAMPTZ | Verification time. |
| NULL | `resolved_at` | TIMESTAMPTZ | Closure time. |
| NULL | `resolved_by` | TEXT | `verification`, `hamel`, `monitor`, etc. |
| NULL | `resolution_note` | TEXT | Manual closure note. |

Indexes:

- `idx_human_required_actions_status_due` on `(status, due_at)`
- `idx_human_required_actions_system_seen` on `(system, last_seen_at DESC)`
- Unique open fingerprint index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_required_actions_open_fingerprint
  ON cortana_human_required_actions (fingerprint)
  WHERE status = 'open';
```

Notes:

- No raw tokens, cookies, credentials, or portal secrets are allowed in `evidence` or `metadata`.
- Store verification as `verification_key` plus typed `verification_args`, not arbitrary shell text.
- Verification keys must resolve through an allowlist before execution.

Alert state-change policy:

| Event | Immediate Alert? | Notes |
|-------|------------------|-------|
| New open fingerprint | Yes | Creates the initial operator-visible item. |
| Severity increases | Yes | Includes `info -> warning`, `warning -> critical`, or family-critical lane escalation. |
| Required action changes | Yes | A new human step is needed. |
| Evidence digest changes materially | Yes | Use typed digest fields such as provider error code, auth scope, permission name, or portal URL category. |
| Detection repeats unchanged before `next_remind_at` | No | Increment `detection_count` and update `last_seen_at`. |
| Item reaches `next_remind_at` | Digest only unless critical | Non-critical reminders stay in the daily autonomy digest. |
| Item reaches `due_at` | Yes | Alert even when the fingerprint is unchanged. |
| Family-critical item remains open past lane threshold | Yes | Re-alert according to `config/autonomy-lanes.json`. |
| Verification fails after human action | Yes | The item is still open and needs a corrected action. |
| Verification passes | No alert by default | Close as `verified`; include in next summary if useful. |
| Previously open item is no longer detected | No immediate alert | Mark `expired` only after the source-specific expiry window. |

Fingerprint and material-change rules:

- `fingerprint` should identify the stable blocker, not every observation. Example dimensions: `system`, `category`, account/provider identifier, permission/scope name, and owner lane.
- Material-change digest should exclude timestamps, counters, raw error strings, and volatile stack traces.
- Severity, due policy, required action, verification key, and material evidence digest must be compared on every update before deciding whether to suppress.

---

## Infrastructure Changes

### SNS Topic Changes

None.

### SQS Queue Changes

None.

### Cache Changes

Mission Control may cache read results per request only. The database is the source of truth.

### S3 Changes

None.

### Secrets Changes

None.

### Network/Security Changes

No new network exposure. Mission Control manual mutation, if added later, must follow existing same-origin/machine-ingress auth rules.

---

## Behavior Changes

- Known human-only blockers create or update one open queue item by fingerprint.
- New or materially changed items can alert once through Monitor.
- Unchanged open items suppress repeated identical alerts.
- Suppression never hides due/overdue, severity-increased, verification-failed, or family-critical threshold events.
- Daily autonomy summaries include waiting-on-Hamel items.
- Verification commands can close items automatically after the human action is completed.
- Family-critical blockers keep stricter escalation and should not be suppressed past the lane threshold.

Safe degradation:

- If the database is unavailable, scripts may emit one actionable warning instead of dropping the blocker.
- If verification is missing or unsafe, the item remains open and requires manual closure.
- If classification confidence is low, create `needs_human`/`unknown` output rather than a misleading next step.

---

## Application/Script Changes

### `cortana`

New files:

- `/Users/hd/Developer/cortana/tools/human-actions/human-required-actions.ts`
  - Schema ensure, create/update, list, suppress, verify, and close functions.
- `/Users/hd/Developer/cortana/tools/human-actions/human-required-actions-cli.ts`
  - CLI for list, upsert, verify, close, and digest.
- `/Users/hd/Developer/cortana/tools/human-actions/human-required-taxonomy.ts`
  - Typed categories, systems, severity, reminder policy, and verification allowlist.
- `/Users/hd/Developer/cortana/tests/human-actions/human-required-actions.test.ts`
  - Covers dedupe, redaction, alert suppression, verification closure, and manual close.

Updated files:

- `/Users/hd/Developer/cortana/tools/monitoring/autonomy-status.ts`
  - Reads open queue items into `waitingOnHuman`.
- `/Users/hd/Developer/cortana/tools/monitoring/autonomy-ops.ts`
  - Includes queued human-required items in summaries.
- `/Users/hd/Developer/cortana/tools/monitoring/autonomy-remediation.ts`
  - Converts blocked/exceeded-authority remediation outcomes into queue items.
- `/Users/hd/Developer/cortana/tools/monitoring/browser-cdp-watchdog.ts`
  - Creates browser-session manual login items where appropriate.
- `/Users/hd/Developer/cortana/tools/alerting/openai-cron-auth-guard.ts`
  - Creates auth/manual-action items for known re-consent failures.
- `/Users/hd/Developer/cortana/config/autonomy-lanes.json`
  - Adds reminder/escalation policy hooks for human-required items.
- `/Users/hd/Developer/cortana/docs/source/doctrine/operating-rules.md`
  - Documents manual-action queue ownership and suppression rules.

### `cortana-external`

New files:

- `/Users/hd/Developer/cortana-external/apps/mission-control/lib/human-required-actions.ts`
  - Reads open and recent human-required queue items from Cortana DB.
- `/Users/hd/Developer/cortana-external/apps/mission-control/lib/human-required-actions.test.ts`
  - Covers query mapping and no-secret display constraints.
- `/Users/hd/Developer/cortana-external/apps/mission-control/app/api/human-required-actions/route.ts`
  - Read endpoint for Mission Control.

Updated files:

- `/Users/hd/Developer/cortana-external/apps/mission-control/app/autonomy/page.tsx`
  - Displays open human-required items when the Autonomy Ops page exists.
- `/Users/hd/Developer/cortana-external/apps/mission-control/README.md`
  - Documents queue read model and operator workflow.

LLM-agnostic implementation rule:

- Taxonomy, dedupe fingerprints, suppression windows, and verification commands must be typed/allowlisted. Do not rely on free-form prompt judgment to decide whether a repeated alert is suppressed.

---

## API Changes

### NEW Human-Required Actions CLI

| Field | Value |
|-------|-------|
| **Interface** | `npx tsx tools/human-actions/human-required-actions-cli.ts <command>` |
| **Description** | Creates, lists, verifies, closes, and summarizes manual-action queue items. |
| **Additional Notes** | Primary v1 write/close interface. |

| Field | Detail |
|-------|--------|
| **Authentication** | Local operator/runtime execution only. |
| **Commands** | `list`, `upsert`, `verify`, `close`, `digest`. |
| **Success Response** | JSON or concise operator output; clean digest can emit `NO_REPLY`. |
| **Error Responses** | Non-zero for invalid taxonomy, unsafe verification command, DB error, or secret-like evidence. |

### NEW `GET /api/human-required-actions`

| Field | Value |
|-------|-------|
| **API** | `GET /api/human-required-actions` |
| **Description** | Returns open and recent human-required queue items for Mission Control. |
| **Additional Notes** | Read-only v1. |

| Field | Detail |
|-------|--------|
| **Authentication** | Same Mission Control browser/machine access model. |
| **URL Params** | Optional `status=open`, `limit`. |
| **Request** | Empty. |
| **Success Response** | `{ ok: true, items: [...] }` |
| **Error Responses** | `{ ok: false, error }` without exposing secrets. |

---

## Process Changes

- Watchdogs and auth guards classify known manual blockers into the queue before alerting.
- Monitor sends state-change alerts and daily digest reminders.
- Operators close items through CLI in v1 after verifying or intentionally ignoring a blocker.
- Mission Control displays the queue as part of Autonomy Ops.

---

## Test Plan

Unit and integration coverage:

- `/Users/hd/Developer/cortana/tests/human-actions/human-required-actions.test.ts`
- `/Users/hd/Developer/cortana/tests/monitoring/autonomy-status.test.ts`
- `/Users/hd/Developer/cortana/tests/monitoring/autonomy-remediation.test.ts`
- `/Users/hd/Developer/cortana-external/apps/mission-control/lib/human-required-actions.test.ts`

Manual or live validation:

- `npx tsx tools/human-actions/human-required-actions-cli.ts upsert --fixture apple-health`
- `npx tsx tools/human-actions/human-required-actions-cli.ts list --status open`
- `npx tsx tools/human-actions/human-required-actions-cli.ts verify --id <id>`
- Open Mission Control Autonomy page after API integration.

Success means:

- Repeated identical detections update one row.
- New state-change sends at most one alert.
- Daily digest includes open non-critical items without repeated immediate alerts.
- Severity increases, overdue state, verification failure, and family-critical threshold events bypass duplicate suppression.
- Verification closes a resolved item with evidence.
- Secret-like values are rejected or redacted before persistence.

---

## Risks / Follow-ups

- Fingerprints must be stable enough to dedupe but specific enough to avoid merging distinct blockers.
- Existing watchdogs may need careful tuning to classify human-required versus transient runtime failures.
- Suppression policy must not hide worsening or overdue blockers.
- Mission Control manual close is useful but should wait until the read model is trusted.
