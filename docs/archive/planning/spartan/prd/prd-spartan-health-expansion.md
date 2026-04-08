# Product Requirements Document (PRD) - Spartan Health Expansion

**Document Status:** Implemented

Shipped on `main`; retained as the design reference for the current system.

## Team

| Role | Assignee |
|------|----------|
| Primary Owner | @hd |
| Epic | Spartan Health Expansion |

---

## Problem / Opportunity

The core Spartan stack can become trustworthy and smart with Tonal, Whoop, and nutrition logs, but there is still a major gap in body-composition and daily activity control:

- body weight is not yet a trusted daily input
- step totals are currently weak or missing
- active energy and broader activity context are incomplete
- body-fat or lean-mass trend inputs do not exist yet

Without those signals, Spartan can coach training well enough, but staying lean and controlling cuts or lean gains remains partially blind.

Apple Health is the most natural future source to close that gap because it can unify:

- body weight
- steps
- activity energy
- distance
- body-composition metrics
- other daily aggregates that do not live cleanly in Whoop or Tonal

The opportunity is to add Apple Health only after the core baseline is good, and to do it in a way that is reliable, privacy-preserving, and explicit about source quality.

---

## Insights

- Apple Health should be treated as an expansion, not a prerequisite. The current stack must be trustworthy first.
- The main value of Apple Health here is not generic “more data.” It is the missing source of truth for body-weight trend, steps, and daily energy context that lean-gain and cut logic need.
- A file-based local export contract is more practical and more LLM-agnostic than assuming a direct HealthKit app integration on macOS from day one.

Problems this project is not intended to solve:

- a native iOS or macOS HealthKit app in the first release
- real-time biometric streaming
- replacing Whoop or Tonal as primary training sources
- medical diagnostics or health-risk interpretation beyond current coaching scope
- new mobile UI surfaces

---

## Development Overview

Add Apple Health as a later-stage source of truth for body weight, step totals, distance, and energy expenditure by introducing a local export-based ingestion contract in `cortana-external` and integrating the normalized daily health summary into Cortana's athlete-state and body-composition logic. Keep the first implementation privacy-preserving, file-based, and read-only, avoid direct iOS/macOS HealthKit app work unless needed later, and encode reconciliation, freshness, and conflict-resolution rules in deterministic code and tests so the expansion remains LLM agnostic.

---

## Success Metrics

- `100%` of Apple Health ingests are freshness-stamped and source-labeled.
- `>= 80%` of days in an active month have usable body-weight coverage once the exporter is configured and used consistently.
- `>= 90%` of days in an active month have step totals from a trusted source once the exporter is configured and used consistently.
- `100%` of body-weight-driven cut or gain logic can point to a concrete source and confidence level.
- `0` future health-expansion decisions rely on hidden, prompt-only reconciliation rules between Apple Health and other providers.

---

## Assumptions

- The baseline and training-intelligence epics are in place before Apple Health materially affects coaching decisions.
- The first Apple Health integration uses a local exported JSON contract rather than a bespoke native app.
- A local sync path such as `~/.openclaw/data/apple-health/latest.json` is acceptable for the first implementation.
- Apple Health becomes the preferred source for body weight and step totals once freshness and consistency are adequate.
- Privacy-sensitive health data remains local to the current machine and repos.

---

## Out of Scope

- a native iPhone companion app in the first release
- direct CloudKit or iCloud private API integration
- medical-grade body-composition interpretation
- continuous glucose, blood pressure, or lab integrations
- replacing Whoop recovery logic

---

## High Level Requirements

> **Note:** Any provisioning and access requirements must also be listed for development.

| Requirement | Description | Notes |
|-------------|-------------|-------|
| [Requirement 1 - Apple Health Export Contract](#requirement-1---apple-health-export-contract) | Define a local, deterministic ingest format for Apple Health data. | File-based first release. |
| [Requirement 2 - External-Service Ingestion](#requirement-2---external-service-ingestion) | Add `cortana-external` support for Apple Health health checks and data reads. | Read-only local service. |
| [Requirement 3 - Normalized Health Storage](#requirement-3---normalized-health-storage) | Persist normalized daily health-source rows and provenance. | Must preserve freshness and source confidence. |
| [Requirement 4 - Body Composition And Activity Integration](#requirement-4---body-composition-and-activity-integration) | Feed body weight, steps, and expenditure into athlete-state and phase logic. | Enables real cut/gain control. |
| [Requirement 5 - Reconciliation And Privacy](#requirement-5---reconciliation-and-privacy) | Resolve source conflicts explicitly and keep sensitive data local. | No silent source switching. |

---

## Detailed User Stories

### Glossary

| Term | Meaning |
|------|---------|
| Apple Health export contract | The structured JSON file format used for the first local ingest. |
| Normalized health row | One daily record with Apple Health-derived metrics and provenance. |
| Source confidence | A structured measure of how much Spartan should trust the imported health data. |
| Reconciliation rule | Deterministic logic that decides how Apple Health interacts with Whoop or manual signals for the same metric. |
| Preferred source | The chosen source for a metric when more than one source exists. |

---

### Requirement 1 - Apple Health Export Contract

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As a developer, I want one explicit JSON export contract so ingestion is deterministic and portable across models. | Avoid bespoke per-run parsing. |
| Accepted | As an athlete, I want setup to be practical without building a native app first. | File-based export is acceptable initially. |
| Accepted | As an operator, I want freshness and schema validation on every ingest. | Prevent silent stale data use. |

---

### Requirement 2 - External-Service Ingestion

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want Apple Health available through the local external service so the coaching stack keeps a consistent data-access pattern. | Mirrors Tonal and Whoop flow. |
| Accepted | As an operator, I want a healthcheck and a data endpoint so failures are diagnosable. | Same operational pattern as other providers. |
| Accepted | As a developer, I want route and schema tests for the ingest layer. | Must be deterministic. |

---

### Requirement 3 - Normalized Health Storage

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want imported health metrics normalized into daily rows with provenance so downstream logic stays simple. | Daily source table required. |
| Accepted | As an operator, I want to know whether a given body-weight or step value came from Apple Health, Whoop, or manual override. | Provenance matters. |
| Accepted | As a developer, I want normalized storage to support later source additions without schema churn. | Future-proofing. |

---

### Requirement 4 - Body Composition and Activity Integration

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an athlete, I want Spartan to manage cut and gain pace using actual body-weight trend rather than guesses. | This is the main value of the expansion. |
| Accepted | As Spartan, I want trusted step and expenditure inputs so daily activity and energy context are real. | Helps staying lean. |
| Accepted | As an operator, I want health-source confidence reflected in the coaching output. | No silent hard assumptions. |

---

### Requirement 5 - Reconciliation and Privacy

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want deterministic conflict rules when Apple Health and other sources disagree. | Example: steps or weight. |
| Accepted | As an athlete, I want private health data to remain local. | No unnecessary remote movement. |
| Accepted | As a developer, I want source switching and fallbacks encoded in code and tests, not hidden in prompts. | LLM agnostic requirement. |

---

## Appendix

### Additional Considerations

This epic should be implemented only after the current baseline is trustworthy.

The first release should prefer:

- local export
- local ingest
- local storage
- explicit reconciliation

over ambitious native integration work.

### User Research

Current-state justification:

- step coverage is currently zero in the monthly summary
- body weight is not yet a trusted ongoing source
- cut and gain logic is therefore missing a key input

Related docs:

- [Program Index](../../../../source/planning/spartan/roadmap/spartan-fitness-program-index.md)
- [Core Baseline PRD](./prd-spartan-fitness-core-baseline.md)
- [Ultimate Fitness Trainer Roadmap](../../../../source/planning/spartan/roadmap/fitness-trainer-roadmap-2026-04-04.md)

### Open Questions

- What is the preferred export path and sync mechanism for the first Apple Health JSON file?
- Should Apple Health become the authoritative step source immediately, or only after a confidence threshold is met?
- Which optional metrics beyond weight and steps are worth including in the first export?
- How should manual overrides interact with Apple Health data for the same day?

### Collaboration Topics

- This epic depends on the current baseline and phase logic being stable.
- The operator should decide the exact export path and whether the export is produced by Shortcut, manual export, or another local automation.

### Technical Considerations

No current Apple Health code exists in the repos today.

This epic will likely introduce:

- a new `apple-health` module in `cortana-external`
- new normalized health-source tables in `cortana`
- updates to athlete-state and body-composition logic
