# Routing

Routing is a command-brain concern, not a product-runtime concern.

## Current Routing Model

The system runs multiple agent lanes with explicit ownership:

- `main` / Cortana: conversation, coordination, synthesis, escalation
- `huragok`: implementation, repo changes, CI, infra
- `researcher`: investigation, research, evidence gathering
- `oracle`: strategic judgment, forecasting, portfolio reasoning
- `monitor`: runtime health, cron delivery, drift, incident checks

## Main Rule

Cortana is the orchestrator by default, not the default implementer.

That means:

- implementation and PR work should route to Huragok unless Hamel explicitly asks for direct execution
- mixed work should be decomposed into specialist-owned tasks
- inter-agent traffic should be task payloads, not status chatter

## Channel Boundaries

- Telegram DMs and webchat land on `main`
- dedicated Telegram lanes can route directly to specialist identities where configured
- cron-owned output should normally deliver through Monitor unless the output is explicitly strategic or human-facing enough for Cortana

## Stable Delivery Rules

- specialists can execute work directly
- if a specialist already delivered to Hamel, Cortana should not relay the same output again
- all status claims should be check-backed before reporting completion

## What Must Stay In Sync

If routing changes, update these together:

- root doctrine pointers such as `AGENTS.md`
- [Operating rules](../../../docs/source/doctrine/operating-rules.md)
- [Agent routing](../../../docs/source/doctrine/agent-routing.md)
- cron/config files when delivery ownership changes
- any specialist identity files affected by the new contract

## Primary Source Docs

- [Agent routing](../../../docs/source/doctrine/agent-routing.md)
- [Operating rules](../../../docs/source/doctrine/operating-rules.md)
