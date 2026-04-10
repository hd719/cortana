# Cortana Core Current State

The `cortana` repo is the command brain for Hamel's agent system.
The runtime body and trading surfaces live in `cortana-external`.

## Repo Role

`cortana` owns the mind-side of the system:

- identity and operator doctrine
- routing and delegation rules
- memory and continuity policy
- cron prompts and command-layer automation
- compiled knowledge pages that summarize current truth

It is not the primary home for external product/runtime implementation. That work mostly lives in `cortana-external`.
Read first if you are unsure about ownership:

1. [Repo split map](../../../docs/source/architecture/repo-split-map.md)
2. [Runtime deploy model](../../../docs/source/architecture/runtime-deploy-model.md)

## Current Layout

- root files (`SOUL.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`) define live boot doctrine
- `memory/` stores continuity, daily notes, and generated runtime state
- `identities/` stores specialist-agent doctrine
- `docs/source/` stores durable source docs, planning artifacts, and architecture notes
- `docs/archive/` stores historical or low-signal docs that should not stay in the active reading path
- `research/` stores raw and derived exploration that has not yet been promoted
- `knowledge/` stores the compiled wiki layer for current truth

Examples of things that stay in `cortana`:

- routing and delegation rules
- cron prompts and command-layer automation
- memory and continuity policy

Examples of things that usually stay in `cortana-external`:

- Mission Control and other runtime UIs
- external service endpoints
- trading/backtester runtime code

## Operating Model

The current operating model is dispatcher-first:

- Cortana owns coordination, verification, and synthesis
- specialist lanes own execution
- code and infra work route to Huragok
- research work routes to Researcher
- market and strategic analysis route to Oracle
- runtime health and cron operations route to Monitor

## Start Here

1. [Cortana core overview](./overview.md)
2. [Routing](./routing.md)
3. [Heartbeat](./heartbeat.md)
4. [Task board](./task-board.md)
5. [Systems index](../../indexes/systems.md)

## Primary Source Docs

- [Root README](../../../README.md)
- [Operating rules](../../../docs/source/doctrine/operating-rules.md)
- [Agent routing](../../../docs/source/doctrine/agent-routing.md)
- [Heartbeat ops](../../../docs/source/doctrine/heartbeat-ops.md)
- [Task board](../../../docs/source/doctrine/task-board.md)
