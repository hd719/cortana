# Technical Specification - Mission Control Autonomy Ops

**Document Status:** Complete

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | Huragok |
| Epic | OpenClaw Autonomy: Mission Control Autonomy Ops |

---

## Development Overview

This cross-repo feature adds a read-only Mission Control page that answers whether Cortana/OpenClaw is self-managing correctly right now. `cortana` owns the status collection and JSON schema; `cortana-external` owns the Mission Control API and UI.

Implementation decision for open PRD questions:

- Data boundary: `cortana` writes a periodic JSON artifact/cache; Mission Control reads the artifact and offers an explicit refresh endpoint for operator use. Mission Control should not shell out on every page load.
- On-demand execution: page load is read-only. The API may call read-only scripts only through a bounded refresh action with timeout and stale-cache fallback. It must not trigger remediation.
- Navigation: add a top-level `Autonomy` page because the view spans runtime health, cron, human-required blockers, self-healing, and task follow-ups. It should not be buried under `Services`.

---

## Data Storage Changes

### Database Changes

No required Mission Control database schema change for v1.

The page may read:

- `cortana_autonomy_incidents` through existing Cortana DB access patterns.
- `cortana_human_required_actions` for operator-owned blockers.
- GitHub Issues for durable engineering follow-ups.

### File / Cache Changes

#### NEW `~/.openclaw/reports/autonomy-ops/latest.json`

`cortana` writes the read model here.

Recommended payload:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-03T00:00:00.000Z",
  "freshUntil": "2026-05-03T00:15:00.000Z",
  "operatorState": "live",
  "posture": "bounded-autonomy",
  "counts": {
    "autoRemediated": 0,
    "escalated": 0,
    "needsHuman": 0,
    "actionable": 0,
    "suppressed": 0
  },
  "sections": {
    "autoFixed": [],
    "degraded": [],
    "waitingOnHuman": [],
    "blocked": [],
    "staleSignals": []
  },
  "sources": [
    {
      "name": "openclaw-status",
      "status": "fresh",
      "generatedAt": "2026-05-03T00:00:00.000Z",
      "freshUntil": "2026-05-03T00:05:00.000Z",
      "lastSuccessfulAt": "2026-05-03T00:00:00.000Z",
      "requiredForState": true,
      "error": null,
      "confidenceImpact": "operator_state"
    }
  ]
}
```

### Cache Changes

Mission Control should treat the artifact as stale after top-level `freshUntil`. Stale data can render, but the UI must label it and avoid presenting stale posture as current truth.

Per-source freshness rules:

- Every source entry must include `name`, `status`, `generatedAt`, `freshUntil`, `lastSuccessfulAt`, `requiredForState`, `error`, and `confidenceImpact`.
- Source statuses are `fresh`, `stale`, `missing`, or `error`.
- `requiredForState=true` means the source can constrain the top-level `operatorState`. A required stale/missing/error source prevents `operatorState=live` even when the artifact file itself was freshly written.
- `confidenceImpact` is one of `operator_state`, `section_only`, or `informational`.
- Top-level `operatorState` is the worst applicable state after source roll-up:
  - `attention` for active critical failure, overdue family-critical human action, or required source error.
  - `watch` for stale required source, missing required source, unresolved non-critical human action, or degraded-but-not-critical signal.
  - `live` only when all required sources are fresh and no section contains active blockers.
- A freshly generated artifact may contain stale source data, but it must surface those stale sources in `sections.staleSignals` and cannot label the whole system live.

---

## Infrastructure Changes

### SNS Topic Changes

None.

### SQS Queue Changes

None.

### S3 Changes

None.

### Secrets Changes

None.

### Network/Security Changes

No new external exposure. Mission Control remains local/Tailscale-private. The refresh endpoint should use the same browser/machine auth rules as existing Mission Control APIs.

---

## Behavior Changes

- Operators can open `/autonomy` to see top-level `live`, `watch`, or `attention` status.
- The page separates active failures, stale signals, auto-fixed items, human-required blockers, and family-critical lane status.
- Page load never mutates runtime state or starts remediation.
- Stale cache is labeled as stale instead of hidden or treated as healthy.
- Human-required items are visible and deduped through the durable queue; `autonomy-status` waiting-on-human output remains supplemental source context.

Safe degradation:

- If the artifact is missing, Mission Control shows an unavailable state with the expected refresh command.
- If refresh fails, Mission Control keeps the last cached payload with a stale/error label.
- If a source is unavailable, the source entry degrades confidence instead of guessing.
- If source metadata is missing or fails schema validation, Mission Control treats that source as `missing` and prevents `operatorState=live`.

---

## Application/Script Changes

### `cortana`

New files:

- `/Users/hd/Developer/cortana/tools/monitoring/write-autonomy-ops-artifact.ts`
  - Builds the Mission Control read model from existing autonomy scripts and writes the local artifact atomically.
- `/Users/hd/Developer/cortana/tests/monitoring/autonomy-ops-artifact.test.ts`
  - Covers schema, freshness, stale source labeling, and `live/watch/attention` examples.

Updated files:

- `/Users/hd/Developer/cortana/tools/monitoring/autonomy-ops.ts`
  - Exposes a stable JSON function/schema for the artifact writer.
- `/Users/hd/Developer/cortana/tools/monitoring/autonomy-status.ts`
  - Ensures waiting-on-human and degraded items are machine-readable.
- `/Users/hd/Developer/cortana/config/cron/jobs.json`
  - Adds or updates a periodic artifact writer job.

### `cortana-external`

New files:

- `/Users/hd/Developer/cortana-external/apps/mission-control/lib/autonomy-ops.ts`
  - Reads and validates the autonomy artifact; optionally runs a bounded refresh.
- `/Users/hd/Developer/cortana-external/apps/mission-control/lib/autonomy-ops.test.ts`
  - Fixture tests for fresh, stale, missing, and attention payloads.
- `/Users/hd/Developer/cortana-external/apps/mission-control/app/api/autonomy-ops/route.ts`
  - Read API for the UI.
- `/Users/hd/Developer/cortana-external/apps/mission-control/app/api/autonomy-ops/refresh/route.ts`
  - Explicit refresh endpoint, read-only scripts only.
- `/Users/hd/Developer/cortana-external/apps/mission-control/app/autonomy/page.tsx`
  - Autonomy Ops page.
- `/Users/hd/Developer/cortana-external/apps/mission-control/app/autonomy/autonomy-client.tsx`
  - Client refresh, filters, and rendering.
- `/Users/hd/Developer/cortana-external/apps/mission-control/app/autonomy/autonomy-client.test.tsx`
  - UI rendering tests.

Updated files:

- `/Users/hd/Developer/cortana-external/apps/mission-control/components/sidebar.tsx`
  - Adds top-level `Autonomy` nav item.
- `/Users/hd/Developer/cortana-external/apps/mission-control/README.md`
  - Documents `/autonomy` and `/api/autonomy-ops`.

LLM-agnostic implementation rule:

- The read model schema should be versioned and validated in code. UI labels should derive from typed states, not free-form script output.

---

## API Changes

### NEW `GET /api/autonomy-ops`

| Field | Value |
|-------|-------|
| **API** | `GET /api/autonomy-ops` |
| **Description** | Returns the latest Autonomy Ops read model for Mission Control. |
| **Additional Notes** | Reads cached artifact; does not run remediation. |

| Field | Detail |
|-------|--------|
| **Authentication** | Same Mission Control browser/machine access model. |
| **URL Params** | None. |
| **Request** | Empty. |
| **Success Response** | `{ ok: true, data, stale, sources }` |
| **Error Responses** | `{ ok: false, error, staleData? }` for missing/invalid artifact. |

### NEW `POST /api/autonomy-ops/refresh`

| Field | Value |
|-------|-------|
| **API** | `POST /api/autonomy-ops/refresh` |
| **Description** | Runs the read-only artifact writer with timeout, then returns the refreshed read model. |
| **Additional Notes** | Must not call remediation scripts. |

| Field | Detail |
|-------|--------|
| **Authentication** | Same Mission Control mutation protections. |
| **Request** | Empty JSON body. |
| **Success Response** | `{ ok: true, data, refreshedAt }` |
| **Error Responses** | `{ ok: false, error, staleData? }` |

---

## Process Changes

- A periodic cron job writes the autonomy artifact.
- Operators use `/autonomy` for first-pass autonomy posture instead of manually combining CLI outputs.
- Manual refresh is explicit and read-only.
- Remediation remains owned by existing CLI/watchdog flows.

---

## Test Plan

Unit and integration coverage:

- `/Users/hd/Developer/cortana/tests/monitoring/autonomy-ops.test.ts`
- `/Users/hd/Developer/cortana/tests/monitoring/autonomy-status.test.ts`
- `/Users/hd/Developer/cortana/tests/monitoring/autonomy-ops-artifact.test.ts`
- `/Users/hd/Developer/cortana-external/apps/mission-control/lib/autonomy-ops.test.ts`
- `/Users/hd/Developer/cortana-external/apps/mission-control/app/autonomy/autonomy-client.test.tsx`

Manual or live validation:

- `npx tsx tools/monitoring/write-autonomy-ops-artifact.ts`
- `curl http://localhost:3000/api/autonomy-ops`
- Open `http://localhost:3000/autonomy`
- Restart Mission Control with `/Users/hd/Developer/cortana-external/apps/mission-control/scripts/restart-mission-control.sh`

Success means:

- Fresh `live`, `watch`, and `attention` fixtures render correctly.
- Missing and stale artifacts render as unavailable/stale, not healthy.
- A fresh artifact with stale required source data renders as `watch` or `attention`, never `live`.
- Page load does not invoke remediation.
- Sidebar exposes `/autonomy` on desktop and mobile.

---

## Risks / Follow-ups

- Cross-repo rollout requires synchronized PRs or staged compatibility.
- Artifact schema drift between repos must be caught by versioned validation.
- Source-level freshness drift must be visible even when the artifact writer ran recently.
- A refresh endpoint can become a hidden shell-out path unless the read-only command allowlist is strict.
