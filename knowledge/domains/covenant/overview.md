# Covenant Overview

The Covenant layer is the specialist-agent orchestration framework under Cortana's command.

## Current Purpose

Covenant exists to give Cortana a structured way to plan, critique, and execute specialist-agent work rather than relying on loose prompt routing.

## Orchestration Model

The active architecture is plan-first:

- planner creates the execution plan
- critic validates structure, thresholds, and budget
- executor decides what can run next and how to retry or escalate

This is the `Roland -> Arbiter -> Executor` model described in the source architecture docs.

## Integration Direction

The intended integration policy is route-first spawning:

- every spawn should pass through the router
- manual agent selection should be rare and auditable
- mixed-intent work should become short handoff chains rather than one agent doing everything badly

## Role Boundaries

The most important role boundary in the current design is:

- Researcher owns evidence gathering
- Oracle owns forecasting and decision modeling

That boundary exists to prevent research tasks from being silently misrouted as strategy work.

## Primary Source Docs

- [Covenant orchestration](../../../docs/source/architecture/covenant-orchestration-v2.md)
- [Covenant integration strategy](../../../docs/source/architecture/covenant-integration-strategy.md)
