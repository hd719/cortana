# Spartan Fitness Program Index

Date: 2026-04-04

## Purpose

This file is the master index for the full Spartan fitness program.

It exists so the roadmap is not just one strategy document. Each major delivery slice has:

- a PRD
- a tech spec
- an implementation plan

The full program is intentionally broken into bounded epics so any LLM can pick up one slice at a time without hidden dependency knowledge.

The detailed per-epic planning triplets are archived under `docs/archive/planning/spartan/` because these epics are already implemented.

## Program Principles

- Keep implementation LLM agnostic.
- Encode rules in typed code, config, schemas, and tests, not only in prompts.
- Land data integrity and canonical state before higher-order coaching features.
- Treat private Tonal and Whoop integrations as unstable dependencies and engineer defensively.
- Degrade confidence when data quality is weak; never fake certainty.
- Keep Apple Health as a later expansion after the current stack is trustworthy.

## Epic Map

| Order | Epic | Purpose | Primary Repo | Status | Docs |
|-------|------|---------|--------------|--------|------|
| 1 | Core Baseline | Fix provider trust, build canonical athlete state, and make nutrition measurable. | `cortana` + `cortana-external` | Implemented | [PRD](../../../../archive/planning/spartan/prd/prd-spartan-fitness-core-baseline.md) · [Tech Spec](../../../../archive/planning/spartan/techspec/techspec-spartan-fitness-core-baseline.md) · [Implementation](../../../../archive/planning/spartan/implementation/implementation-spartan-fitness-core-baseline.md) |
| 2 | Training Intelligence | Convert clean athlete-state data into weekly dose, fatigue, progression, and cut-aware training decisions. | `cortana` | Implemented | [PRD](../../../../archive/planning/spartan/prd/prd-spartan-training-intelligence.md) · [Tech Spec](../../../../archive/planning/spartan/techspec/techspec-spartan-training-intelligence.md) · [Implementation](../../../../archive/planning/spartan/implementation/implementation-spartan-training-intelligence.md) |
| 3 | Tonal Programming | Convert recommendations into Tonal-ready plans, templates, and deterministic tomorrow-session outputs. | `cortana` with `cortana-external` support | Implemented | [PRD](../../../../archive/planning/spartan/prd/prd-spartan-tonal-programming.md) · [Tech Spec](../../../../archive/planning/spartan/techspec/techspec-spartan-tonal-programming.md) · [Implementation](../../../../archive/planning/spartan/implementation/implementation-spartan-tonal-programming.md) |
| 4 | Coaching Operating Loop | Turn isolated cron messages into a closed-loop coaching system with check-ins, compliance, alerts, and outcome evaluation. | `cortana` | Implemented | [PRD](../../../../archive/planning/spartan/prd/prd-spartan-coaching-operating-loop.md) · [Tech Spec](../../../../archive/planning/spartan/techspec/techspec-spartan-coaching-operating-loop.md) · [Implementation](../../../../archive/planning/spartan/implementation/implementation-spartan-coaching-operating-loop.md) |
| 5 | Health Expansion | Add Apple Health as the future source for body weight, step totals, expenditure, and body-composition trend logic. | `cortana-external` + `cortana` | Implemented | [PRD](../../../../archive/planning/spartan/prd/prd-spartan-health-expansion.md) · [Tech Spec](../../../../archive/planning/spartan/techspec/techspec-spartan-health-expansion.md) · [Implementation](../../../../archive/planning/spartan/implementation/implementation-spartan-health-expansion.md) |

## Roadmap Traceability

| Roadmap Phase | Owning Epic |
|---------------|------------|
| Phase 0 - Fix trust and measurement | Core Baseline |
| Phase 1 - Canonical athlete state | Core Baseline |
| Phase 2 - Make nutrition real | Core Baseline |
| Phase 3 - Build the training intelligence layer | Training Intelligence |
| Phase 4 - Tonal-native programming and workout generation | Tonal Programming |
| Phase 5 - Coaching UX and operating loop | Coaching Operating Loop |
| Future Apple Health expansion | Health Expansion |

Reference roadmap:

- [Ultimate Fitness Trainer Roadmap](./fitness-trainer-roadmap-2026-04-04.md)

## Dependency Order

```text
Core Baseline
  -> Training Intelligence
    -> Tonal Programming
    -> Coaching Operating Loop
      -> Health Expansion

Health Expansion also feeds back into:
  -> Training Intelligence
  -> Coaching Operating Loop
```

Important nuance:

- Tonal Programming depends on the recommendation logic from Training Intelligence.
- Coaching Operating Loop depends on canonical athlete state and recommendation outputs, but can begin partial work once baseline tables and daily decisions exist.
- Health Expansion is intentionally later because body-weight and expenditure logic are only worth integrating after the current Tonal + Whoop + nutrition loop is reliable.

## Capability Coverage

| Capability | Epic Owner |
|------------|------------|
| Whoop dedupe and provider quality flags | Core Baseline |
| Canonical daily athlete state | Core Baseline |
| Protein, calories, hydration, and phase-aware nutrition targets | Core Baseline |
| Weekly dose model by muscle group | Training Intelligence |
| Fatigue, progression, deload, and cut-aware rules | Training Intelligence |
| Cardio interference logic | Training Intelligence |
| Tonal library classification and template planning | Tonal Programming |
| Deterministic “what should I do on Tonal tomorrow?” output | Tonal Programming |
| Today mission, check-ins, alerts, compliance, and outcome scoring | Coaching Operating Loop |
| Body weight, steps, expenditure, and body-composition trend integration | Health Expansion |

## Global Scope Boundaries

- No medical diagnosis or injury treatment logic.
- No official Tonal public API assumptions unless such an API is later verified.
- No new mobile app in this planning set.
- No Apple Health work before the baseline is trustworthy.
- No prompt-only policy logic where deterministic code or config is required.

## Global Risks

- Unofficial Tonal endpoints may drift and break field assumptions.
- Whoop payload quirks can silently distort training load unless quality checks remain strict.
- Tonal movement taxonomy work can become a maintenance burden if unmapped movements are not surfaced clearly.
- Body-composition control remains incomplete until body weight has a trusted source.
- Cron reliability matters because the current operator experience depends on scheduled message delivery.

## Review Order

If you want to review this in implementation order:

1. [Core Baseline PRD](../../../../archive/planning/spartan/prd/prd-spartan-fitness-core-baseline.md)
2. [Core Baseline Tech Spec](../../../../archive/planning/spartan/techspec/techspec-spartan-fitness-core-baseline.md)
3. [Core Baseline Implementation](../../../../archive/planning/spartan/implementation/implementation-spartan-fitness-core-baseline.md)
4. [Training Intelligence PRD](../../../../archive/planning/spartan/prd/prd-spartan-training-intelligence.md)
5. [Training Intelligence Tech Spec](../../../../archive/planning/spartan/techspec/techspec-spartan-training-intelligence.md)
6. [Training Intelligence Implementation](../../../../archive/planning/spartan/implementation/implementation-spartan-training-intelligence.md)
7. [Tonal Programming PRD](../../../../archive/planning/spartan/prd/prd-spartan-tonal-programming.md)
8. [Tonal Programming Tech Spec](../../../../archive/planning/spartan/techspec/techspec-spartan-tonal-programming.md)
9. [Tonal Programming Implementation](../../../../archive/planning/spartan/implementation/implementation-spartan-tonal-programming.md)
10. [Coaching Operating Loop PRD](../../../../archive/planning/spartan/prd/prd-spartan-coaching-operating-loop.md)
11. [Coaching Operating Loop Tech Spec](../../../../archive/planning/spartan/techspec/techspec-spartan-coaching-operating-loop.md)
12. [Coaching Operating Loop Implementation](../../../../archive/planning/spartan/implementation/implementation-spartan-coaching-operating-loop.md)
13. [Health Expansion PRD](../../../../archive/planning/spartan/prd/prd-spartan-health-expansion.md)
14. [Health Expansion Tech Spec](../../../../archive/planning/spartan/techspec/techspec-spartan-health-expansion.md)
15. [Health Expansion Implementation](../../../../archive/planning/spartan/implementation/implementation-spartan-health-expansion.md)
