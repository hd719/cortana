# Review Chains

## Purpose
Review chains are a post-completion hook: after a builder agent finishes qualifying work, a reviewer agent is automatically spawned to validate output quality and operational integrity.

## Chain Mappings
- **Huragok** (code/infra) → **Librarian** (docs review) + **Monitor** (health validation)
- **Librarian** (docs) → **Monitor** (verify docs match reality)
- **Researcher** (analysis) → **Oracle** (strategic review of findings)

## When to Chain
Run review chains only for tasks that modify:
- code
- documentation
- configuration

Do **not** chain for one-off queries or purely informational responses.

## Reviewer Input Format
When spawning a reviewer, pass:
1. Builder output summary
2. List of files changed

This gives reviewers enough context to validate both intent and implementation.

## Skip Conditions
Skip review-chain spawning when:
- the original task is trivial (**fewer than 3 files changed**), or
- the original task is time-sensitive and immediate delivery is prioritized.
