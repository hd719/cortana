# OpenClaw Planning Index

This directory is the active front door for OpenClaw planning work in `cortana`.

Use this area for durable planning artifacts that affect the command-brain side of OpenClaw. Runtime-owned application surfaces and market/trading implementation details still live in `cortana-external`.

## Structure

- `prd/` - product requirements for OpenClaw-facing changes
- `techspec/` - technical design and system contracts
- `implementation/` - execution plans and task breakdowns
- `qa/` - validation criteria and test coverage expectations

## Start Here

- [OpenClaw knowledge overview](../../../../knowledge/domains/openclaw/overview.md)
- [Vacation Ops PRD](./prd/prd-vacation-ops-mode.md)
- [Vacation Ops Tech Spec](./techspec/techspec-vacation-ops-mode.md)
- [Vacation Ops Implementation Plan](./implementation/implementation-vacation-ops-mode.md)
- [Vacation Ops QA Spec](./qa/qa-spec-vacation-ops-mode.md)

## Active Design Sets

### OpenClaw Autonomy Improvements

Completed planning set for the autonomy hardening pass:

| Initiative | Status | PRD | Tech Spec | Implementation Plan |
|------------|--------|-----|-----------|---------------------|
| Deterministic Maintenance Jobs | Complete - inventory, command runner, source validation, eligible rollout, runtime smoke coverage, and runbook notes are implemented. | [PRD](./prd/prd-deterministic-maintenance-jobs.md) | [Tech Spec](./techspec/techspec-deterministic-maintenance-jobs.md) | [Implementation Plan](./implementation/implementation-deterministic-maintenance-jobs.md) |
| Cron Runtime State Reconciler | Complete - evidence/classification/apply/report/runbook, post-merge dry-run, delivery monitor filtering, and daily digest summary are implemented. | [PRD](./prd/prd-cron-runtime-state-reconciler.md) | [Tech Spec](./techspec/techspec-cron-runtime-state-reconciler.md) | [Implementation Plan](./implementation/implementation-cron-runtime-state-reconciler.md) |
| Mission Control Autonomy Ops | Complete - cached artifact, Mission Control API/page/sidebar, refresh endpoint, periodic cron writer, and tests are implemented. | [PRD](./prd/prd-mission-control-autonomy-ops.md) | [Tech Spec](./techspec/techspec-mission-control-autonomy-ops.md) | [Implementation Plan](./implementation/implementation-mission-control-autonomy-ops.md) |
| Human-Required Action Queue | Complete - durable queue, CLI, real producers, Mission Control read API, and Autonomy page display are implemented. | [PRD](./prd/prd-human-required-action-queue.md) | [Tech Spec](./techspec/techspec-human-required-action-queue.md) | [Implementation Plan](./implementation/implementation-human-required-action-queue.md) |

### Vacation Ops Mode

This planning set defines a bounded vacation mode for Cortana/OpenClaw operations:

- prepare a vacation window from deterministic readiness checks
- downgrade non-critical automations while preserving core operator safety
- send morning and evening vacation summaries
- quarantine fragile automations that become noisy during the window

Status: implemented. The source tree contains the schema/config foundation, canonical state and CLI, readiness engine, remediation/state-machine logic, summaries, cron wiring, and focused test coverage. Latest live status check reports no active vacation window and latest readiness outcome `pass`.

Current source artifacts:

- [PRD](./prd/prd-vacation-ops-mode.md)
- [Tech Spec](./techspec/techspec-vacation-ops-mode.md)
- [Implementation Plan](./implementation/implementation-vacation-ops-mode.md)
- [QA Spec](./qa/qa-spec-vacation-ops-mode.md)
