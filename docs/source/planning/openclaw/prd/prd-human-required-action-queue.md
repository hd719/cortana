# Product Requirements Document (PRD) - Human-Required Action Queue

**Document Status:** Draft

## Team

| Role | Assignee |
|------|----------|
| Primary Owner | Monitor |
| Epic | OpenClaw Autonomy: Human-Required Action Queue |

---

## Problem / Opportunity

Some operational problems cannot be fixed autonomously: phone app installs, OAuth re-consent, OS privacy permissions, Schwab portal actions, browser login renewal, and similar user-controlled steps. Today these can appear as degraded runtime state or repeated alerts even when the system already knows the next step requires Hamel.

The opportunity is to create a durable human-required action queue that classifies these items once, dedupes alerts, exposes them in Mission Control, and suppresses repeated watchdog noise until the action is completed or overdue.

---

## Insights

- Autonomy policy already distinguishes auto-act, ask-first, and human-required classes.
- Runbooks identify human-required failures such as OAuth re-consent and Apple/TCC permissions.
- Autonomy status has a `waiting on Hamel` concept, but it is not yet consistently populated.
- Repeated alerts for known human-required setup reduce trust in automation.

Problems this project is not intended to solve:

- Performing human-only actions automatically.
- Storing secrets or credentials in the queue.
- Hiding urgent failures that newly affect delivery.

---

## Development Overview

Implementation spans:

- `cortana` for classification, queue storage, and Monitor-owned alert policy
- `cortana-external` for Mission Control display

The queue should store structured action items with owner, system, reason, required human step, evidence, due/expiry policy, and verification command. Scripts and watchdogs should write to the queue instead of sending repeated alerts for the same known manual blocker.

---

## Success Metrics

- Known human-required blockers appear once in the queue with a clear next action.
- Repeated identical alerts are suppressed while an item is open.
- Completion can be verified by a deterministic check.
- Mission Control shows all open human-required items.
- No secrets or raw tokens are written to queue records.
- Family-critical blockers still escalate according to stricter policy.

---

## Assumptions

- PostgreSQL `cortana` DB is available for durable queue storage.
- Mission Control can read the queue through its existing Cortana DB connection.
- Human-required items can be fingerprinted for dedupe.
- Verification commands can be safe read-only checks.

---

## Out of Scope

- Secret entry or credential storage UI.
- Full approval workflow replacement.
- Automatic financial actions or OAuth consent.
- Mobile app development.

---

## High Level Requirements

| Requirement | Description | Notes |
|-------------|-------------|-------|
| [Requirement 1 - Queue schema](#requirement-1---queue-schema) | Store durable human-required action records. | Include dedupe fingerprint. |
| [Requirement 2 - Classification writers](#requirement-2---classification-writers) | Watchdogs/scripts create or update queue items. | No raw secrets. |
| [Requirement 3 - Alert suppression](#requirement-3---alert-suppression) | Suppress repeated alerts for unchanged open items. | Digest or state-change alerts only. |
| [Requirement 4 - Operator surface](#requirement-4---operator-surface) | Show queue in Mission Control and autonomy summaries. | Read-only v1 is acceptable. |
| [Requirement 5 - Verification and closure](#requirement-5---verification-and-closure) | Close items after deterministic recovery proof. | Manual close with reason also allowed. |

---

## Detailed User Stories

### Glossary

| Term | Meaning |
|------|---------|
| Human-required action | A blocker that needs Hamel to perform a step outside autonomous authority. |
| Fingerprint | Stable dedupe key for one recurring blocker. |
| Verification command | Read-only command proving the human action has resolved the blocker. |

---

### Requirement 1 - Queue Schema

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Monitor, I want to record a human-required blocker with system, reason, next step, and evidence. | Example systems: `apple_health`, `schwab`, `google_oauth`, `browser_session`. |
| Accepted | As a developer, I want a fingerprint so repeated detections update one item instead of creating duplicates. | Include `first_seen`, `last_seen`, `alert_count`. |

---

### Requirement 2 - Classification Writers

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As watchdog, I want to classify known manual blockers instead of repeatedly alerting as generic degradation. | Use explicit taxonomy. |
| Accepted | As autonomy remediation, I want blocked/exceeded-authority outcomes to create queue items. | Align with autonomy policy. |

---

### Requirement 3 - Alert Suppression

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Hamel, I want one clear alert when a new manual action is needed. | State-change only. |
| Accepted | As Hamel, I do not want repeated identical alerts while the item is still open. | Exception: overdue or family-critical escalation. |

---

### Requirement 4 - Operator Surface

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Hamel, I want open manual actions visible in Mission Control. | Include next step and verification status. |
| Accepted | As Cortana, I want autonomy summaries to include waiting-on-Hamel items. | Compact list, no secrets. |

---

### Requirement 5 - Verification And Closure

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Monitor, I want queue items auto-closed after verification passes. | Example: Schwab `ready`, Apple Health configured/fresh enough. |
| Accepted | As Hamel, I want to manually mark an item resolved or ignored with a note. | Later Mission Control mutation. |

---

## Appendix

### Candidate Initial Taxonomy

- `human_auth`: OAuth re-consent or refresh token rejected
- `human_permission`: OS/TCC/privacy permission required
- `human_setup`: app install, device pairing, missing local export
- `human_portal`: provider developer portal action
- `human_browser`: browser login/session renewal

### Example Items

- Apple Health app not installed or export not configured.
- Schwab refresh token rejected; rerun local OAuth flow.
- Google/Gog OAuth consent expired.
- Browser CDP profile needs manual login renewal.

### Open Questions

- Should queue storage be a new table or reuse `cortana_tasks` with metadata?
- Should Mission Control v1 allow manual close, or read-only display first?
- What cadence should remind Hamel about open non-critical items?
