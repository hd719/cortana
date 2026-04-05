# Product Requirements Document (PRD) - <initiative-name>

**Document Status:** Draft

## Team

| Role | Assignee |
|------|----------|
| Primary Owner | <owner> |
| Epic | <initiative-name> |

---

## Problem / Opportunity

Describe the problem in concrete terms.

- what exists today
- what is broken, missing, or unreliable
- why the current state is not good enough
- what opportunity this work unlocks

Call out explicit non-goals early if they are likely to cause confusion.

---

## Insights

Summarize the reasoning behind the project.

- what evidence or observed pain makes this worth doing
- what constraints shape the design
- what prior work or repo context matters

Problems this project is not intended to solve:

- <non-goal-1>
- <non-goal-2>
- <non-goal-3>

---

## Development Overview

Explain the intended build at a high level.

This section should be readable by a human or LLM that has not seen the rest of the project yet.

Include:

- which repo or repos are involved
- where the main implementation will live
- what must be deterministic in code vs left to prompt behavior
- what is intentionally deferred

---

## Success Metrics

Define how success will be measured.

- use specific observable outcomes
- prefer exact thresholds where possible
- include quality and failure-mode expectations when relevant

Example shapes:

- `0` duplicate records in a persisted payload
- `100%` of generated artifacts include explicit quality flags
- `>= 90%` of mapped events resolve to a known taxonomy

---

## Assumptions

List assumptions the project depends on.

- repo ownership assumptions
- service availability assumptions
- provider or API stability assumptions
- testing and rollout assumptions

---

## Out of Scope

Be explicit about what this project will not do.

- <out-of-scope-1>
- <out-of-scope-2>
- <out-of-scope-3>

---

## High Level Requirements

> **Note:** Include provisioning, access, or environment requirements if they block development.

| Requirement | Description | Notes |
|-------------|-------------|-------|
| [Requirement 1 - <name>](#requirement-1---name) | <short description> | <notes> |
| [Requirement 2 - <name>](#requirement-2---name) | <short description> | <notes> |
| [Requirement 3 - <name>](#requirement-3---name) | <short description> | <notes> |

---

## Detailed User Stories

State how the completed system should behave and where users or operators will interact with it.

### Glossary

| Term | Meaning |
|------|---------|
| <term> | <definition> |
| <term> | <definition> |

---

### Requirement 1 - <name>

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As a <user>, I want <capability> so that <outcome>. | <notes> |
| Accepted | As an <operator>, I want <capability> so that <outcome>. | <notes> |

---

### Requirement 2 - <name>

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As a <user>, I want <capability> so that <outcome>. | <notes> |
| Accepted | As a <developer>, I want <capability> so that <outcome>. | <notes> |

---

### Requirement 3 - <name>

| Status | User story | Notes |
|--------|------------|-------|
| Accepted | As a <user>, I want <capability> so that <outcome>. | <notes> |
| Accepted | As an <operator>, I want <capability> so that <outcome>. | <notes> |

---

## Appendix

Include any supporting material that helps the next implementer.

### Additional Considerations

This repo should remain LLM agnostic.

That means:

- name exact repos, files, services, tables, and tests when they matter
- encode rules in deterministic code, typed config, or explicit schemas
- do not leave essential behavior only in prompt wording
- make the scope understandable without hidden project context

### User Research

Capture observed evidence, references, or measurements that justify the work.

### Open Questions

- <question-1>
- <question-2>
- <question-3>
