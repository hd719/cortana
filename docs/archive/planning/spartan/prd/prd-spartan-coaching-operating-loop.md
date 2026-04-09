# Product Requirements Document (PRD) - Spartan Coaching Operating Loop

**Document Status:** Implemented

Shipped on `main`; retained as the design reference for the current system.

## Team

| Role | Assignee |
|------|----------|
| Primary Owner | @hd |
| Epic | Spartan Coaching Operating Loop |

---

## Problem / Opportunity

Spartan already has a real runtime presence:

- morning brief
- evening recap
- weekly insights
- monthly overview
- freshness and recovery guardrails
- conversation syncing into coaching tables

But the experience is still fragmented.

What is missing:

- one clear `today mission` object that anchors the day
- structured post-workout or midday check-ins
- explicit compliance tracking against recommendations
- alert policy beyond a few narrow risk checks
- outcome evaluation that tells whether Spartan's advice is actually improving results

The opportunity is to turn the current cron messages into a real closed-loop operating system for fitness coaching. This is the layer that makes Spartan feel like one coherent coach instead of several disconnected scripts.

---

## Insights

- The current cron and identity scaffolding is already strong enough to support a closed-loop coaching system; the missing pieces are structured state, explicit contracts, and evaluation.
- User updates are already arriving as natural-language messages. The system should parse, link, and score those messages instead of treating them as disposable chat.
- Outcome evaluation is required if Spartan is supposed to get smarter over time. Recommendation quality must be measured, not assumed.

Problems this project is not intended to solve:

- new mobile or web UI surfaces
- replacing Telegram as the primary user-facing channel
- medical monitoring or emergency escalation logic
- Apple Health ingestion
- direct Tonal workout creation

---

## Development Overview

Turn the current cron messages into a closed-loop coaching system in `cortana` by adding a daily mission artifact, structured check-in ingestion, post-workout note parsing, alert policies, compliance tracking, and weekly/monthly outcome evaluation that all read from the canonical athlete state and training recommendation layers. Keep the communication surface concise in Telegram, preserve Spartan's existing identity and cadence, and encode message contracts, alert thresholds, and evaluation rules in deterministic code and cron tests so the loop remains LLM agnostic and operationally reliable.

---

## Success Metrics

- `100%` of active training days can produce a structured `today mission` artifact.
- `100%` of user check-ins that mention training completion, misses, soreness, pain, or schedule constraints are parsable into structured fields or explicitly flagged as unparsed.
- `100%` of coaching alerts are logged with alert type, severity, and delivery state.
- `100%` of weekly coaching summaries include an outcome evaluation score and short explanation of what improved or regressed.
- `0` cron messages rely on hidden prompt-only rules for alert thresholds, compliance state, or outcome scoring.

---

## Assumptions

- Core Baseline and Training Intelligence are available before the full operating loop is completed.
- Telegram remains the user-facing delivery channel for this phase.
- Natural-language user updates continue to be the main source for training completion, soreness, and ad hoc context.
- `coach_conversation_log`, `coach_decision_log`, and `coach_weekly_score` remain the base coaching tables and can be extended.
- Current cron jobs in `~/.openclaw/cron/jobs.json` stay as the main orchestration surface.

---

## Out of Scope

- new native or browser UI
- Apple Health ingestion
- direct Tonal session mutation
- medical or injury-diagnosis workflows
- generalized life coaching outside the fitness domain

---

## High Level Requirements

> **Note:** Any provisioning and access requirements must also be listed for development.

| Requirement | Description | Notes |
|-------------|-------------|-------|
| [Requirement 1 - Today Mission Contract](#requirement-1---today-mission-contract) | Produce one structured daily mission that summarizes readiness, top risk, plan, and non-negotiables. | Morning surface anchor. |
| [Requirement 2 - Structured Check-In Ingestion](#requirement-2---structured-check-in-ingestion) | Parse user updates into completion, soreness, pain, motivation, and schedule context. | Must remain natural-language friendly. |
| [Requirement 3 - Alert Policy](#requirement-3---alert-policy) | Expand risk alerts into a consistent alerting policy with logging and dedupe. | Must stay concise and operator-safe. |
| [Requirement 4 - Compliance And Coaching Memory](#requirement-4---compliance-and-coaching-memory) | Track adherence to recommendations and preserve meaningful coaching patterns. | Must use structured state. |
| [Requirement 5 - Outcome Evaluation](#requirement-5---outcome-evaluation) | Score whether Spartan’s coaching improved readiness, training quality, and adherence over time. | This is the learning loop. |

---

## Detailed User Stories

### Glossary

| Term | Meaning |
|------|---------|
| Today mission | The structured daily coaching object containing readiness, priority, plan, risk, and one non-negotiable action. |
| Check-in | A user-provided natural-language update that may contain completion, soreness, pain, fatigue, motivation, or schedule context. |
| Alert policy | Deterministic rules deciding when Spartan should proactively alert instead of waiting for the next recap. |
| Compliance state | Whether a recommendation was completed, missed, deferred, or contradicted by later user input. |
| Outcome evaluation | A weekly or monthly score describing whether Spartan’s recent guidance aligned with better recovery, training consistency, and adherence. |

---

### Requirement 1 - Today Mission Contract

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an athlete, I want one clear today mission so I know what matters without reconciling multiple messages myself. | Must be concise and operational. |
| Accepted | As Spartan, I want a structured mission artifact so later alerts and compliance tracking refer to the same plan. | One source of truth for the day. |
| Accepted | As an operator, I want the mission contract to be testable and stable. | Cron contract matters. |

---

### Requirement 2 - Structured Check-In Ingestion

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an athlete, I want to send normal natural-language updates and have Spartan interpret them correctly. | No rigid form-fill UX required. |
| Accepted | As Spartan, I want soreness, pain, misses, and scheduling constraints extracted from user messages so later recommendations reflect reality. | Needed for safe adaptation. |
| Accepted | As a developer, I want parsed entity logic and fallback behavior covered by tests. | Must be LLM agnostic. |

---

### Requirement 3 - Alert Policy

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want one alert policy framework instead of one-off special scripts. | Freshness, recovery risk, overreach, missed protein, and pain are examples. |
| Accepted | As an athlete, I want alerts that are concise, relevant, and not noisy. | Dedupe and severity matter. |
| Accepted | As an operator, I want every alert logged so false positives and gaps can be reviewed later. | Alert ops need evidence. |

---

### Requirement 4 - Compliance and Coaching Memory

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As Spartan, I want to know whether the athlete actually followed the recommendation so I can avoid coaching in a vacuum. | Completion matters. |
| Accepted | As an athlete, I want recommendations to adapt when I miss sessions, report pain, or change time constraints. | Real life should feed back in. |
| Accepted | As an operator, I want stable patterns preserved in Spartan memory without polluting it with one-off noise. | Must align with `MEMORY.md` rules. |

---

### Requirement 5 - Outcome Evaluation

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As an operator, I want a weekly score showing whether Spartan’s guidance is improving actual outcomes. | Readiness, adherence, performance, and risk all matter. |
| Accepted | As Spartan, I want structured outcome feedback so future policy tuning is evidence-based. | This is the learning loop. |
| Accepted | As a developer, I want evaluation rules encoded in code and DB state rather than hand-wavy summaries. | Portable and testable. |

---

## Appendix

### Additional Considerations

This epic is where Spartan becomes an operating system instead of a reporting layer.

The design needs to preserve the current voice:

- concise
- direct
- no fluff
- action first

but add stronger structure beneath that presentation.

### User Research

Existing runtime evidence:

- fitness cron jobs already exist in `~/.openclaw/cron/jobs.json`
- `coach-conversation-sync.ts` already parses some compliance and caffeine signals from chat
- Spartan identity and memory files already define boundaries and operating rules

Related docs:

- [Program Index](../../../../source/planning/spartan/roadmap/spartan-fitness-program-index.md)
- [Training Intelligence PRD](./prd-spartan-training-intelligence.md)
- [Ultimate Fitness Trainer Roadmap](../../../../source/planning/spartan/roadmap/fitness-trainer-roadmap-2026-04-04.md)

### Open Questions

- Should today mission replace the current morning artifact as the source of truth, or should it sit one level beneath it?
- How aggressive should pain or soreness parsing be before an alert is sent?
- Should compliance scoring stay rule-based forever, or later become partially tuned from outcomes?
- What is the minimum set of check-in entity types needed for the first release?

### Collaboration Topics

- This epic depends on the baseline and training-intelligence outputs being stable first.
- Any cron additions or contract changes must preserve delivery reliability and be covered by cron contract tests.

### Technical Considerations

Current files and config that this epic must align with:

- `tools/fitness/coach-conversation-sync.ts`
- `tools/fitness/morning-brief-data.ts`
- `tools/fitness/evening-recap-data.ts`
- `tools/fitness/weekly-insights-data.ts`
- `tools/fitness/coach-db.ts`
- `identities/spartan/IDENTITY.md`
- `identities/spartan/MEMORY.md`
- `identities/spartan/SOUL.md`
- `~/.openclaw/cron/jobs.json`
