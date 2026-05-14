# Product Requirements Document (PRD) - Mission Control Autonomy Ops

**Document Status:** Complete

## Team

| Role | Assignee |
|------|----------|
| Primary Owner | Huragok |
| Epic | OpenClaw Autonomy: Mission Control Autonomy Ops |

---

## Problem / Opportunity

Autonomy status is spread across CLI tools, watchdog state, cron state, OpenClaw status, Mission Control health, human-required items, and GitHub Issue follow-ups. The system has the right ingredients, but there is no single operator surface that answers: “Is Cortana self-managing correctly right now?”

The opportunity is to add a Mission Control Autonomy Ops page that aggregates bounded autonomy state, stale/noisy signals, human-required items, and recent self-healing actions into one trusted view.

---

## Insights

- `autonomy-ops`, `autonomy-rollout`, `autonomy-status`, `autonomy-scorecard`, and `autonomy-drill` already exist.
- Watchdog and OpenClaw status provide separate runtime truth.
- Mission Control is already the operator UI for agents, runs, human-required items, feedback, and Trading Ops.
- Current operator interpretation still requires running multiple commands manually.

Problems this project is not intended to solve:

- Implementing new remediation logic.
- Replacing command-line tools.
- Making Mission Control public internet-facing.

---

## Development Overview

This is a cross-repo feature:

- `cortana` owns the autonomy status scripts and schemas.
- `cortana-external` owns Mission Control UI/API.

The first version should expose a read-only Mission Control page backed by a small API that calls or reads the existing autonomy surfaces. Mutating controls can be deferred until the read model is trusted.

---

## Success Metrics

- One page shows current autonomy posture, state, and blockers without running local commands.
- Page distinguishes `live`, `watch`, and `attention`.
- Human-required items are visible and deduped.
- Stale/noisy signals are labeled separately from active failures.
- A freshly written artifact with stale required source data cannot show `live`.
- Page load does not trigger remediation actions.
- API response is covered by tests using fixture payloads.

---

## Assumptions

- Mission Control can read `cortana` repo scripts or a generated JSON artifact from the same machine.
- Autonomy scripts can provide stable JSON output.
- Operator access remains local/Tailscale private network.
- The first version is read-only.

---

## Out of Scope

- Adding buttons that restart services or mutate cron state.
- Building mobile push notifications.
- Replacing Telegram alerts.
- Reworking Mission Control navigation beyond adding one page/link.

---

## High Level Requirements

| Requirement | Description | Notes |
|-------------|-------------|-------|
| [Requirement 1 - Unified read model](#requirement-1---unified-read-model) | Produce one Autonomy Ops payload for Mission Control. | Prefer JSON artifact or API boundary. |
| [Requirement 2 - Operator page](#requirement-2---operator-page) | Display autonomy state, blockers, follow-ups, and recent actions. | Read-only v1. |
| [Requirement 3 - Signal quality](#requirement-3---signal-quality) | Separate active failures, stale state, human-required items, and healthy probes. | Avoid false urgency. |
| [Requirement 4 - Validation](#requirement-4---validation) | Test API and UI rendering against representative states. | Include `live`, `watch`, `attention`. |

---

## Detailed User Stories

### Glossary

| Term | Meaning |
|------|---------|
| Operator state | Top-level autonomy state: `live`, `watch`, or `attention`. |
| Human-required item | Work blocked on Hamel, such as OAuth consent, app install, or OS permission. |
| Stale signal | Historical failure evidence that no longer reflects current runtime state. |

---

### Requirement 1 - Unified Read Model

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Mission Control, I want a stable JSON autonomy payload so that UI logic does not shell out in React components. | API/server side only. |
| Accepted | As an operator, I want source, timestamp, freshness, and confidence impact for each included signal. | Prevent stale dashboard truth. |

---

### Requirement 2 - Operator Page

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Hamel, I want to see whether Cortana is `live`, in `watch`, or needs `attention`. | First viewport signal. |
| Accepted | As Hamel, I want to see what was auto-fixed recently and what is still blocked. | Include task ids when available. |
| Accepted | As Monitor, I want family-critical lane status separated from routine maintenance. | Never-miss lanes get higher visual priority. |

---

### Requirement 3 - Signal Quality

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an operator, I want stale historical failures labeled as stale instead of active. | Depends on reconciler when available. |
| Accepted | As Hamel, I want human-required setup items visible without repeated watchdog alerts. | Example: Apple Health install, OAuth reauth. |
| Accepted | As Monitor, I want stale or missing required sources to degrade the top-level state. | Fresh artifact does not mean fresh source truth. |

---

### Requirement 4 - Validation

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As a developer, I want fixture tests for `live`, `watch`, and `attention`. | API model plus UI rendering. |
| Accepted | As an operator, I want a smoke check verifying the page can load against local runtime. | Similar to Trading Ops smoke. |

---

## Appendix

### Candidate Data Sources

- `npx tsx tools/monitoring/autonomy-ops.ts --json`
- `npx tsx tools/monitoring/autonomy-status.ts`
- `npx tsx tools/monitoring/autonomy-rollout.ts`
- `npx tsx tools/monitoring/autonomy-scorecard.ts`
- `watchdog/watchdog-state.json`
- `openclaw status --deep`
- cron state / cron reconciler output

### Implementation Decisions

- `cortana` writes a periodic JSON artifact for Mission Control to read.
- Mission Control page load reads cached output only. Explicit refresh may run bounded read-only scripts with stale-cache fallback.
- Navigation uses a top-level `Autonomy` page.
- Every source in the artifact carries source-level freshness and confidence impact. Required stale/missing/error sources prevent `operatorState=live`.
