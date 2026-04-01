# Autonomy Policy

This file defines Cortana's bounded decision authority for reliability, break/fix, and operator hygiene.

## Severity Model

- **P1 — Immediate risk / user-visible impact:** gateway down, delivery broken, critical cron missed, repeated dispatch failures, destructive drift, security-sensitive surprises.
- **P2 — Degraded but recoverable:** cron timeouts, stuck sessions, noisy drift PRs, repeated auto-sync friction, partial tool failures.
- **P3 — Routine maintenance:** cleanup, retries, stale-state repair, non-destructive hygiene, documentation sync.

## Decision Authority

### Auto-act without asking
Take safe, reversible, internal actions immediately when impact is limited and rollback is clear.

Examples:
- retry, restart, re-run, or clean up failed internal workflows
- kill stale sessions or reset orphaned task/run state
- bump internal timeout/retry settings when evidence is clear
- revert or close bad runtime-drift / auto-sync PRs before merge
- patch docs, prompts, or routing rules to match explicit operator decisions

### Ask first
Ask before actions that are risky, irreversible, financially meaningful, externally visible, or change product direction.

Examples:
- destructive deletes beyond normal recoverable cleanup
- sending new external messages not already required by an incident workflow
- financial trades, purchases, approvals, credential changes, or access expansion
- schema/data migrations with real blast radius
- large behavioral rewrites, net-new autonomy loops, or policy changes with unclear edge cases

### Escalate immediately
Page Hamel immediately when delay is worse than noise.

Triggers:
- P1 reliability failure with user-visible impact
- repeated failures after one safe remediation attempt
- security/privacy risk or uncertain blast radius
- conflicting signals where acting wrong could make recovery harder
- any issue that blocks core command, delivery, or recovery paths

## Default Response Loop

1. **Detect** — confirm the signal with logs, status, or state.
2. **Scope** — identify affected workflow, session, delivery path, and blast radius.
3. **Act** — take the smallest safe reversible action.
4. **Verify** — re-check the system, not the hope.
5. **Report** — say what failed, why, what was done, and what happens next.

## Failure-Class Playbooks

### 1) Gateway / channel reliability
- Check gateway status and delivery path first.
- Auto-act: restart/retry internal services, re-run failed delivery checks, confirm recovery.
- Escalate if delivery remains broken, restart loops persist, or user-visible messages are at risk.

### 2) Cron failures / timeouts
- Confirm whether failure was execution, timeout, or delivery.
- Auto-act: retry once when safe, clean stale run state, adjust timeout/retry settings only when evidence supports it, then verify next-run health.
- Escalate if a critical cron is missed, repeated timeouts continue, or the root cause is unclear after one bounded fix.

### 3) Session sprawl / session cleanup
- Detect stale, orphaned, or duplicated sessions and task mappings.
- Auto-act: kill stale sessions, reconcile task state, prune obvious ghosts, and verify no active work was harmed.
- Escalate if ownership is ambiguous, active work may be interrupted, or session churn suggests deeper runtime instability.

### 4) Bad runtime-drift / auto-sync PRs
- Treat noisy, misleading, or drift-only PRs as operational debt, not progress.
- Auto-act: close or revert clearly bad internal drift PRs, tighten ignore/routing rules, and document the fix path.
- Escalate if the PR may contain real source changes mixed with noise, or if repo/running-state truth is ambiguous.

## Activation / Visibility

- Autonomy posture is configured in `config/autonomy-lanes.json`.
  - `balanced` is the default posture.
  - Current rollout keeps posture intentionally light-touch: one bounded remediation, verify, then escalate.
- Family-critical reliability lanes are explicitly tracked in `config/autonomy-lanes.json` and currently include calendar reminders, appointments/family logistics, pregnancy-sensitive reminders/checklists, and other never-miss personal ops.
  - These lanes should not silently degrade.
  - If the first bounded remediation does not restore verified delivery, escalate.
- Session lifecycle auto-remediation is active through `tools/session/session-lifecycle-policy.ts`.
- Runtime deploy drift detection / actionable-only reporting is active through `tools/monitoring/runtime-repo-drift-monitor.ts`.
- Bounded service recovery is active through `tools/monitoring/autonomy-remediation.ts` (gateway restart once with verification, channel recovery via existing delivery hooks, critical cron single-retry recovery, and session lifecycle cleanup verification).
- Canonical autonomy incident state now lives in `cortana_autonomy_incidents` and is written by `tools/monitoring/critical-synthetic-probe.ts` and `tools/monitoring/autonomy-remediation.ts`.
  - Goal: one DB-backed incident lifecycle (`open` -> `resolved`) instead of scattered script-local state.
  - Repeated unchanged failures should not keep paging; state-change and verified recovery are the meaningful operator signals.
- Browser/CDP bounded recovery is active through `tools/monitoring/browser-cdp-watchdog.ts` and `tools/monitoring/autonomy-remediation.ts` (one `openclaw node restart`, then verify endpoint health, then escalate).
- Vacation-mode fragile-job quarantine is active through `tools/monitoring/vacation-mode-guard.ts` and `tools/monitoring/autonomy-remediation.ts` when `config/autonomy-lanes.json -> vacationMode.enabled=true`.
  - Vacation mode intentionally tightens alerting and quarantines fragile cron jobs sooner (first consecutive error by default).
- Operator visibility: run `npx tsx tools/monitoring/autonomy-status.ts` for a compact executive summary of what was auto-fixed, what failed then recovered, what still needs Hamel, and what exceeded authority or was deferred.
- Operator surface: run `npx tsx tools/monitoring/autonomy-ops.ts` for one clean operator view across status, rollout state, family-critical handling, and blocked/deferred attention items. It suppresses unchanged repeat chatter so stale copies do not keep paging.
- Daily executive digest: run `npx tsx tools/monitoring/autonomy-daily-digest.ts` for the compact once-daily operator digest covering auto-fixes, recovered degradation, human-needed items, authority blocks, and family-critical lane status.
- Live drill support: run `npx tsx tools/monitoring/autonomy-drill.ts` for bounded live-fire readiness across gateway, channel, critical cron, repo handoff, and family-critical scenarios.
- Live rollout gate: run `npx tsx tools/monitoring/autonomy-rollout.ts`.
  - Healthy live state stays quiet.
  - Bounded auto-remediation without open operator work reports `watch`.
  - Any escalations, actionable drift, or missing required inputs return explicit `attention` output and non-zero exit.
- Steady-state cadence: autonomy rollout should be checked every 4 hours. Healthy paths stay quiet; operator summaries should fire only when rollout is in `attention` and the state changed.
- Daily cadence: send one executive autonomy digest each evening with the compact operator summary; healthy/no-action days degrade to digest-only instead of paging.
- Drill cadence: run a bounded autonomy drill/readiness sweep once weekly to keep gateway, delivery, critical cron, repo handoff, and family-critical lanes exercised without noisy constant probing.
- Validation coverage lives in `tests/session/session-lifecycle-policy.test.ts`, `tests/monitoring/runtime-repo-drift-monitor.test.ts`, `tests/monitoring/autonomy-status.test.ts`, `tests/monitoring/autonomy-rollout.test.ts`, `tests/monitoring/autonomy-drill.test.ts`, `tests/monitoring/autonomy-ops.test.ts`, `tests/monitoring/autonomy-remediation.test.ts`, and `tests/alerting/cron-auto-retry.test.ts`.

## Guardrails

- Prefer the smallest action that restores truth and stability.
- Reversible beats clever.
- Internal autonomy is default; external consequence still requires judgment.
- Never claim green without verification.
