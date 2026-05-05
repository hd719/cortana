# Product Requirements Document (PRD) - Deterministic Maintenance Jobs

**Document Status:** Complete

## Team

| Role | Assignee |
|------|----------|
| Primary Owner | Huragok |
| Epic | OpenClaw Autonomy: Deterministic Maintenance Jobs |

---

## Problem / Opportunity

OpenClaw maintenance automation currently uses many `agentTurn` cron jobs whose prompts instruct the agent to run exactly one command and then return `NO_REPLY` or a short alert. This adds model latency, token cost, prompt drift risk, and failure modes unrelated to the underlying maintenance script.

The opportunity is to move deterministic maintenance paths into script-first execution, preserving agent escalation only when a script emits actionable output or requires judgment.

Non-goal: this project does not remove agent-based cron jobs that need reasoning, synthesis, or conversational context.

---

## Insights

- Many cron prompts contain “First action: exec exactly ...” contracts.
- Healthy maintenance paths are supposed to stay silent.
- Current model-mediated wrappers make simple checks vulnerable to model/runtime drift.
- Existing scripts already encode most deterministic behavior.

Problems this project is not intended to solve:

- Redesigning the whole OpenClaw scheduler.
- Changing high-value summary crons such as morning brief.
- Granting broader autonomy than the existing bounded policy allows.

---

## Development Overview

Implementation primarily belongs in `cortana`, with possible OpenClaw runtime integration depending on scheduler support.

The build should:

- inventory cron jobs that only run a deterministic command
- define a script-first job contract
- migrate eligible jobs away from `agentTurn`
- preserve `NO_REPLY` quiet-path semantics
- preserve Monitor-owned delivery for actionable alerts
- provide compatibility fallback when direct script jobs are unavailable

Runtime-owned behavior must be deployed through `tools/deploy/sync-runtime-from-cortana.sh`.

---

## Success Metrics

- `>= 80%` of deterministic maintenance jobs no longer require a model turn.
- Healthy maintenance runs produce `0` Telegram messages.
- Migrated jobs preserve current alert behavior for actionable failures.
- Median runtime for migrated jobs drops versus the prior agent-turn path.
- No increase in missed critical maintenance alerts for 14 days after rollout.

---

## Assumptions

- OpenClaw cron can support or be extended to support direct command-style execution under the existing cron job envelope.
- Existing maintenance scripts are the right source of deterministic behavior.
- Monitor remains the user-facing owner for operational maintenance alerts.
- Runtime sync can safely deploy tracked cron config changes.

---

## Out of Scope

- Rewriting the scheduler from scratch.
- Migrating research, trading synthesis, morning brief, or other judgment-heavy crons.
- Changing Telegram account routing.
- Removing watchdog or autonomy remediation layers.

---

## High Level Requirements

| Requirement | Description | Notes |
|-------------|-------------|-------|
| [Requirement 1 - Job inventory](#requirement-1---job-inventory) | Identify deterministic agent-turn maintenance jobs. | Source: `config/cron/jobs.json` |
| [Requirement 2 - Script-first contract](#requirement-2---script-first-contract) | Define direct command execution, output handling, timeout, and delivery rules. | Must preserve `NO_REPLY` |
| [Requirement 3 - Migration and fallback](#requirement-3---migration-and-fallback) | Migrate eligible jobs with a safe fallback path. | Roll out incrementally |
| [Requirement 4 - Verification](#requirement-4---verification) | Prove migrated jobs run, stay quiet when healthy, and alert when actionable. | Include tests and runtime checks |

---

## Detailed User Stories

### Glossary

| Term | Meaning |
|------|---------|
| Deterministic maintenance job | A cron job whose prompt only asks the agent to run a fixed command and interpret a fixed output contract. |
| Script-first job | A cron job executed directly as a command without an LLM turn in the healthy path. |
| Actionable output | Script output requiring a user-visible alert or follow-up. |

---

### Requirement 1 - Job Inventory

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an operator, I want a generated list of deterministic maintenance jobs so that migration scope is explicit. | Include job id, command, owner, timeout, and quiet-path rule. |
| Accepted | As a developer, I want risky or judgment-heavy jobs excluded so that the migration is conservative. | Exclusion reason should be recorded. |

---

### Requirement 2 - Script-First Contract

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an operator, I want direct jobs to treat exact `NO_REPLY` as silent success so that healthy checks do not page me. | No Telegram send on healthy paths. |
| Accepted | As Monitor, I want actionable script output to be delivered with `accountId=monitor` so that ownership stays correct. | Same routing contract as current prompts. |
| Accepted | As a developer, I want exit code, stdout, stderr, duration, and timeout captured deterministically. | Log to cron state and/or events. |
| Accepted | As a developer, I want the direct command contract pinned to `payload.kind=command` or an explicit wrapper-mode fallback. | No top-level command job shape. |

---

### Requirement 3 - Migration And Fallback

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an operator, I want each migration to be reversible per job so that a bad rollout does not affect unrelated jobs. | Feature flag or config-level fallback. |
| Accepted | As a developer, I want legacy `agentTurn` definitions preserved until the direct runner proves stable. | Avoid irreversible migration. |

---

### Requirement 4 - Verification

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an operator, I want a smoke command proving all migrated jobs can run locally. | Should not send Telegram unless forced. |
| Accepted | As a developer, I want tests for output routing, timeout behavior, and `NO_REPLY` handling. | Include regression for literal `NO_REPLY`. |

---

## Appendix

### Candidate Jobs

Initial candidates include:

- Main Bootstrap Refresh
- Subagent Reliability Reaper
- Session Lifecycle Policy Check
- Ops Routing Drift Check
- Runtime vs Repo Drift Monitor
- Browser CDP Watchdog
- OpenAI Auth Preflight/Sweep

### Implementation Decisions

- The tracked command job shape uses the existing cron job envelope with `payload.kind=command`. Top-level `type=command` jobs are invalid.
- If live OpenClaw does not support `payload.kind=command`, v1 deploys wrapper-mode `payload.kind=agentTurn` entries and preserves the canonical command spec in metadata.
- Direct jobs write scheduler-visible cron state and `cortana_events` where available.
- Actionable output uses the existing `telegram-delivery-guard.sh` in v1 so Monitor routing stays unchanged.
