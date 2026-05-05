# Implementation Plan - Human-Required Action Queue

**Document Status:** In Implementation

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | Monitor |
| Epic | OpenClaw Autonomy: Human-Required Action Queue |
| Tech Spec | [Tech Spec](../techspec/techspec-human-required-action-queue.md) |
| PRD | [PRD](../prd/prd-human-required-action-queue.md) |

---

## Dependency Map

| Vertical | Dependencies | Can Start? |
|----------|--------------|------------|
| V1 - Queue schema and library | None | Start now |
| V2 - Writers and suppression | V1 | Start after schema |
| V3 - Verification and CLI closure | V1, V2 | Start after writers |
| V4 - Mission Control read surface | V1 | Can run in parallel after schema |

---

## Recommended Execution Order

```text
Week 1: DB schema, typed taxonomy, queue library, tests
Week 2: Watchdog/remediation writers, typed alert policy, CLI list/close
Week 3: Verification keys, Mission Control read API/UI integration, digest policy
```

---

## Sprint 1 - Queue Core

### Vertical 1 - Queue schema and library

**cortana: store human-required blockers with dedupe, redacted evidence, and lifecycle state.**

*Dependencies: None*

**Implementation status:** Queue storage/library and CLI/verification are implemented with typed taxonomy, DB-backed queue store, redaction, dedupe/material-change policy, digest, close, and focused tests. Producer integrations and Mission Control read surfaces remain later verticals.

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana/tools/human-actions/human-required-actions.ts`.
- Sub-task 2: Create `/Users/hd/Developer/cortana/tools/human-actions/human-required-taxonomy.ts`.
- Sub-task 3: Add `/Users/hd/Developer/cortana/tests/human-actions/human-required-actions.test.ts`.

#### Testing

- Schema ensure creates `cortana_human_required_actions`.
- Repeated fingerprint updates one open item.
- Material-change digest excludes volatile timestamps and raw stack traces.
- Secret-like evidence is rejected or redacted.
- Closed item plus same fingerprint creates a new open occurrence only when appropriate.

---

## Sprint 2 - Producers And Suppression

### Vertical 2 - Classification writers

**cortana: convert known manual blockers into queue items before alerting.**

*Dependencies: V1*

#### Jira

- Sub-task 1: Update `/Users/hd/Developer/cortana/tools/monitoring/autonomy-remediation.ts` to enqueue blocked/exceeded-authority outcomes.
- Sub-task 2: Update `/Users/hd/Developer/cortana/tools/monitoring/browser-cdp-watchdog.ts` for browser login/manual profile blockers.
- Sub-task 3: Update `/Users/hd/Developer/cortana/tools/alerting/openai-cron-auth-guard.ts` for known auth re-consent blockers.

#### Important Planning Notes

- Start with a narrow taxonomy: OAuth/auth, OS permission/setup, provider portal, browser session.
- Transient runtime failures should not be prematurely classified as human-required.
- Family-critical blockers can suppress exact duplicates only until their lane escalation threshold.
- Suppression decisions must compare typed severity, required action, verification key, due policy, and material evidence digest.

#### Testing

- First detection creates an item and permits one state-change alert.
- Repeated unchanged detection increments counters and suppresses immediate duplicate alert.
- Materially changed evidence updates the item and allows a new state-change alert.
- Severity increase, overdue state, verification failure, and family-critical threshold events bypass duplicate suppression.

### Vertical 3 - CLI and verification

**cortana: let Monitor list, verify, and close queue items without Mission Control mutations.**

*Dependencies: V1, V2*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana/tools/human-actions/human-required-actions-cli.ts`.
- Sub-task 2: Implement `list`, `upsert`, `verify`, `close`, and `digest`.
- Sub-task 3: Add verification-key allowlist and closure tests.

#### Testing

- `list --status open` returns redacted operator output.
- `verify --id <id>` resolves only allowlisted `verification_key` entries and typed arguments before running a read-only check.
- `close --id <id> --reason resolved` records `resolved_by` and note.
- Clean digest can emit `NO_REPLY`.

---

## Sprint 3 - Operator Surface

### Vertical 4 - Mission Control read model

**cortana-external: display open human-required items in Mission Control and Autonomy Ops.**

*Dependencies: V1*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana-external/apps/mission-control/lib/human-required-actions.ts`.
- Sub-task 2: Create `/Users/hd/Developer/cortana-external/apps/mission-control/app/api/human-required-actions/route.ts`.
- Sub-task 3: Integrate open items into `/Users/hd/Developer/cortana-external/apps/mission-control/app/autonomy/page.tsx` after the Autonomy Ops page exists.

#### Testing

- API maps DB rows into redacted display items.
- Missing Cortana DB returns a clear unavailable state.
- UI shows system, severity, next action, last seen, due state, and verification status.

---

## Dependency Notes

### V1 before V2

Writers need a stable schema and taxonomy so each producer does not invent its own categories or fingerprints.

### V2 before V3

Verification and closure are most useful once real producers can create queue items.

### V1 before V4

Mission Control should read the durable table directly rather than a temporary adapter.

---

## Scope Boundaries

### In Scope

- Durable manual-action queue.
- Typed taxonomy and fingerprint dedupe.
- Alert suppression for unchanged open items.
- Typed alert state-change policy with due/overdue and family-critical bypasses.
- CLI list/verify/close.
- Read-only Mission Control display.

### External Dependencies

- Cortana PostgreSQL database.
- Mission Control Cortana DB connection.
- Existing watchdog/auth guard classification signals.

### Integration Points

- `/Users/hd/Developer/cortana/tools/monitoring/autonomy-status.ts`
- `/Users/hd/Developer/cortana/tools/monitoring/autonomy-ops.ts`
- `/Users/hd/Developer/cortana-external/apps/mission-control/app/autonomy/page.tsx`

---

## Realistic Delivery Notes

The MVP is the table, library, CLI, and one real producer. Mission Control can follow once the read shape is stable.

- **Biggest risks:** over-suppressing urgent failures, unstable fingerprints, accidental secret persistence, treating arbitrary stored command text as executable verification.
- **Assumptions:** DB is available, manual blockers can be safely fingerprinted, non-critical reminders belong in daily digest.
