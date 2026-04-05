# Technical Specification - <initiative-name>

**Document Status:** Draft

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | <owner> |
| Epic | <initiative-name> |

---

## Development Overview

Summarize the build in implementation terms.

Include:

- what the system will do after the change
- which repos or services are affected
- what must be deterministic and test-covered
- what remains intentionally unchanged

---

## Data Storage Changes

Describe database, file, cache, or state-shape changes.

### Database Changes

#### [NEW or UPDATE] <table-or-store-name>

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| <constraints> | <column> | <type> | <notes> |
| <constraints> | <column> | <type> | <notes> |

Notes:

- <note-1>
- <note-2>

---

## Infrastructure Changes (if any?)

### SNS Topic Changes

None.

### SQS Queue Changes

None.

### Cache Changes

Describe cache shape, retention, freshness, or invalidation changes.

### S3 Changes

None.

### Secrets Changes

None.

### Network/Security Changes

Describe any auth, host, firewall, or transport changes.

---

## Behavior Changes

Describe how behavior changes for users, operators, jobs, or downstream systems.

- <behavior-change-1>
- <behavior-change-2>
- <behavior-change-3>

Also describe safe degradation or failure behavior if relevant.

---

## Application/Script Changes

List new and updated files with exact paths.

New files:

- `/Users/hd/Developer/cortana/<path-to-new-file>`
  - <what it does>

Updated files:

- `/Users/hd/Developer/cortana/<path-to-updated-file>`
  - <what changes>

If multiple repos are involved, split the section by repo.

LLM-agnostic implementation rule:

- no essential rule should exist only in prose
- thresholds and mappings should live in typed constants or stable schemas
- uncertain data should degrade confidence instead of being guessed away

---

## API Changes

Document endpoint or interface changes.

### [NEW or UPDATE] <endpoint-or-interface-name>

| Field | Value |
|-------|-------|
| **API** | `<method> <path>` |
| **Description** | <description> |
| **Additional Notes** | <notes> |

| Field | Detail |
|-------|--------|
| **Authentication** | <auth> |
| **URL Params** | <params> |
| **Request** | <request shape> |
| **Success Response** | <success shape> |
| **Error Responses** | <error behavior> |

If there are no API changes, say so explicitly.

---

## Process Changes

Call out workflow, cron, operator, or rollout changes.

- <process-change-1>
- <process-change-2>

---

## Test Plan

Name the verification surface directly.

Unit and integration coverage:

- `/Users/hd/Developer/cortana/<test-path>`
- `/Users/hd/Developer/cortana/<test-path>`

Manual or live validation:

- <manual-check-1>
- <manual-check-2>

Success means:

- <expected-result-1>
- <expected-result-2>

---

## Risks / Open Questions

- <risk-or-question-1>
- <risk-or-question-2>
- <risk-or-question-3>
