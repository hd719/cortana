# Autonomy Stabilization Overview

This document is the plain-English map of the autonomy stabilization work completed for Cortana.

It exists so the system does not depend on memory, vibes, or chat archaeology.

## Goal

Turn Cortana from a capable assistant into a **boringly reliable operator** that can:
- detect operational issues,
- take bounded safe action,
- verify the result,
- escalate clearly when needed,
- stay quiet when healthy,
- and protect family-critical / never-miss lanes with stricter handling.

## What was built

### Step 1 — Autonomy doctrine
Added the policy layer for:
- auto-act without asking,
- ask-first actions,
- escalate-immediately conditions,
- severity model,
- detect → scope → act → verify → report loop.

### Step 2 — Initial operational hardening
Moved selected reliability flows from detect-only toward:
- detect,
- bounded action,
- verification,
- exception-only alerting.

### Step 3 — Validation + visibility
Added initial validation and operator visibility so autonomy changes were not just doctrine in a file.

### Step 4 — Service-specific remediation
Added bounded remediation authority for high-value failure classes such as:
- gateway recovery,
- channel/provider recovery,
- critical cron recovery.

### Step 5 — Tuning + family-critical lanes
Added the family-critical / never-miss concept and tuned the autonomy model around higher-stakes personal operations.

### Step 6 — Rollout / live-ops summary
Added rollout/live-ops visibility so autonomy could be observed in steady-state operation.

### Step 7 — PR handoff hardening
Fixed the "baton-drop" failure mode where work could complete locally but no PR/result was surfaced cleanly.

### Step 8 — Live-fire drills + operator surface
Added:
- bounded autonomy drills,
- one clean operator surface,
- stricter family-critical visibility.

Key entrypoints:
- `npx tsx tools/monitoring/autonomy-drill.ts`
- `npx tsx tools/monitoring/autonomy-ops.ts`
- `npx tsx tools/monitoring/autonomy-rollout.ts`

### Step 9 — Operational cadence + stale-detector hardening
Added:
- operator cadence,
- daily executive autonomy digest,
- weekly drill cadence,
- stale-detector JSON hardening,
- quieter steady-state operation.

### Step 10 — Trust pass
Added:
- freshness suppression for stale follow-up chatter,
- autonomy trust scorecard,
- active follow-up visibility,
- consistent post-action follow-through.

Key trust/summary entrypoints:
- `npx tsx tools/monitoring/autonomy-status.ts`
- `npx tsx tools/monitoring/autonomy-scorecard.ts`
- `npx tsx tools/monitoring/autonomy-daily-digest.ts`

### Step 11 — Family-critical failover + incident review loop
Added:
- explicit family-critical failover semantics,
- stricter escalation when never-miss delivery remains uncertain,
- incident review logging in the scorecard path,
- policy lessons attached to meaningful incidents.

## Operating principles

### 1) Quiet when healthy
Healthy paths should stay silent.
The system should not create noise just because it can talk.

### 2) Bounded remediation
Autonomy acts within safe limits:
- one bounded retry,
- one bounded restart,
- verify,
- escalate if uncertainty remains.

### 3) Family-critical is stricter
Never-miss lanes include things like:
- appointments,
- calendar logistics,
- pregnancy reminders/checklists,
- family-critical reminders.

These should escalate faster and require explicit verification.

### 4) Freshness matters
If reality already changed, stale alerts should be suppressed or relabeled.
Old truth should not masquerade as current truth.

### 5) Follow-through matters
Meaningful actions should not disappear into chat scroll.
They should leave:
- scorecard traces,
- digest visibility,
- follow-up tasks when needed,
- incident-review context when useful.

## Main operator surfaces

### Operator surface
Use when you want one compact operational view:
- `npx tsx tools/monitoring/autonomy-ops.ts`

Shows, in one place:
- auto-fixed items,
- degraded items,
- what is waiting on Hamel,
- blocked/exceeded-authority items,
- family-critical state,
- trust scorecard summary.

### Daily executive digest
Use for compact daily review:
- `npx tsx tools/monitoring/autonomy-daily-digest.ts`

### Drill surface
Use for bounded live-fire readiness checks:
- `npx tsx tools/monitoring/autonomy-drill.ts`

### Status surface
Use for raw autonomy health/status:
- `npx tsx tools/monitoring/autonomy-status.ts`

### Trust scorecard
Use for production trust metrics + incident reviews:
- `npx tsx tools/monitoring/autonomy-scorecard.ts`

## What to watch in production

When evaluating whether autonomy is working well, focus on only a few things:
1. Missed or late important reminders
2. Stale or obviously wrong alerts
3. Duplicate/noisy chatter
4. Failures Cortana should have acted on but did not
5. Cases where Cortana acted, but the action was wrong, too aggressive, or incomplete

## Tracking follow-up issues

Standing epic:
- `Autonomy Stabilization / Production Tuning`

Shared intake doc:
- `docs/autonomy-stabilization-intake.md`

Use that intake doc when logging issues from any agent lane.

## Current intended mode

The intended system behavior is:
- quiet when healthy,
- visible when it matters,
- self-healing when safe,
- explicit when blocked,
- stricter on family-critical lanes,
- and measurable enough to tune from evidence instead of guesswork.

## What this is not

This is not magic.
This is not omniscience.
This is not unlimited autonomy.

It is a bounded, observable, operator-style system designed to reduce dependence on Hamel being constantly present for routine break/fix and operational supervision.

## Short version

Cortana autonomy stabilization built:
- doctrine,
- remediation,
- visibility,
- drills,
- cadence,
- trust metrics,
- freshness suppression,
- family-critical failover,
- and an incident review loop.

The goal is simple:
**less noise, more dependable action, better protection of what matters.**
