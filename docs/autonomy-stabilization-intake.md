# Autonomy Stabilization Intake

Use this when logging a new issue into the task board under the standing epic:

- **Epic:** `Autonomy Stabilization / Production Tuning`

## When to log an issue

Log it if it affects **trust, timing, or correctness**, especially:
1. Missed or late important reminders
2. Stale / obsolete / wrong alerts
3. Duplicate or noisy chatter
4. Cortana failed to act when she should have
5. Cortana acted, but the action was wrong, too aggressive, or incomplete

Do **not** log every tiny paper cut. Log issues that matter to operational trust.

## Required template

- **Title:** short issue name
- **Type:** `reliability` | `observability` | `family-critical` | `tuning`
- **What happened:**
- **Impact:**
- **What Cortana did:**
- **What should have happened:**
- **Severity:** `low` | `medium` | `high`
- **Suggested owner:** `Monitor` | `Huragok` | `Researcher` | `Oracle` | `Cortana`

## Short command form

Agents may accept a short intake like:

> Add issue to **Autonomy Stabilization / Production Tuning**: stale researcher alert after PR merge; impact confusion/trust hit; Cortana surfaced outdated email truth; should have been suppressed; type observability; severity medium; owner Researcher.

## Normalization rules

Before adding a task:
- Check whether the issue is already represented on the board.
- If it is a duplicate, append context to the existing task instead of creating a new one.
- If the underlying reality already changed, label it as a **freshness/staleness** issue instead of logging the old state as if it were still active.
- Prefer one task per distinct failure mode, not one task per repeated symptom.

## Suggested labels / buckets

### Reliability
- missed remediation
- failed recovery
- retry logic gap
- failover gap

### Observability
- stale alert
- duplicate alert
- missing digest context
- bad scorecard data
- operator surface confusion

### Family-critical
- reminder delivery uncertainty
- escalation too weak
- escalation too noisy
- fallback path gap

### Tuning
- too aggressive
- too timid
- wrong threshold
- wrong owner / routing

## Done condition for a logged issue

A task is ready for closure when:
- the failure mode is fixed or intentionally tuned,
- the correct owner is clear,
- and the expected future behavior is explicit.

## One-line reminder for agents

If you are an agent logging an issue: keep it concise, de-duplicate first, and optimize for **useful follow-up**, not narrative flair.
