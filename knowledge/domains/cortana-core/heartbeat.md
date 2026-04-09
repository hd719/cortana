# Heartbeat

The heartbeat layer is the proactive operating loop for Cortana.

## What Heartbeat Owns

Heartbeat is responsible for:

- periodic proactive checks
- quiet-hours-aware monitoring behavior
- maintenance of continuity and operator state
- surfacing overdue reminders, task drift, and system anomalies
- keeping the command brain current without turning it into a noisy alert firehose

## Current Delivery Policy

The active policy is quiet-by-default:

- healthy maintenance paths should stay silent
- routine ops delivery should prefer Monitor
- Cortana should only speak when the output is high-signal enough to matter to Hamel

This keeps the command lane usable and prevents cron noise from masquerading as value.

## Practical Shape

The current system uses heartbeat to:

- sweep ready tasks and reminders
- inspect cron and runtime health
- refresh continuity and memory-related state
- decide whether a human-visible escalation is warranted

## Current Constraint

The old vacation-mode behavior is no longer part of the active operational surface.
Current heartbeat docs and cron config assume normal quiet-hours and escalation behavior without a separate vacation lane.

## Primary Source Docs

- [Heartbeat ops](../../../docs/source/doctrine/heartbeat-ops.md)
- [README cron policy](../../../README.md)
