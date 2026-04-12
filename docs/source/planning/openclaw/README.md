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

### Vacation Ops Mode

This planning set defines a bounded vacation mode for Cortana/OpenClaw operations:

- prepare a vacation window from deterministic readiness checks
- downgrade non-critical automations while preserving core operator safety
- send morning and evening vacation summaries
- quarantine fragile automations that become noisy during the window

Current source artifacts:

- [PRD](./prd/prd-vacation-ops-mode.md)
- [Tech Spec](./techspec/techspec-vacation-ops-mode.md)
- [Implementation Plan](./implementation/implementation-vacation-ops-mode.md)
- [QA Spec](./qa/qa-spec-vacation-ops-mode.md)
