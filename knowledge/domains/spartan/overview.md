# Spartan Overview

Spartan is the fitness coaching domain inside `cortana`.

## What Exists Now

The Spartan lane is no longer just a plan. It already has:

- a dedicated identity scaffold under `identities/spartan/`
- live cron coverage for fitness summaries and checks
- artifact builders and fitness persistence tooling in `tools/fitness/`
- external service support from `cortana-external`

So the active Spartan docs should be read as system summaries and operator guidance, not as speculative product planning.

## Current Goal

The system is trying to act as a reliable, evidence-backed fitness coach that can:

- interpret readiness and recovery
- understand Tonal workouts at a session and movement level
- support body-composition-aware coaching
- drive daily and weekly decisions automatically
- improve from outcome history rather than generic advice

## Current Reading Path

- [Roadmap](./roadmap.md)
- [Planning index](../../../docs/source/planning/spartan/README.md)
- [Operator guide](../../../docs/source/planning/spartan/usage/README.md)

## Archive Boundary

The per-epic PRD, Tech Spec, and Implementation triplets are already implemented and now live under `docs/archive/planning/spartan/`.
The active source surface is intentionally much smaller.

## Primary Source Docs

- [Planning index](../../../docs/source/planning/spartan/README.md)
- [Program index](../../../docs/source/planning/spartan/roadmap/spartan-fitness-program-index.md)
- [Fitness roadmap](../../../docs/source/planning/spartan/roadmap/fitness-trainer-roadmap-2026-04-04.md)
- [Operator guide](../../../docs/source/planning/spartan/usage/README.md)
