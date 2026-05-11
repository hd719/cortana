# PRD: Spartan Event-Driven Coaching

## Summary

Move Spartan wake/recovery and workout coaching from fixed morning crons to WHOOP webhook-triggered analysis.

The current time-based jobs fire whether the relevant physiology event has happened or not. With live WHOOP webhook delivery working, Spartan should respond when the underlying event arrives.

## Goals

- Trigger Spartan coaching from fresh WHOOP events instead of fixed morning/workout schedules.
- Keep the existing webhook precursor Telegram message so operators know the webhook fired.
- Preserve evening, weekly, and monthly long-horizon coaching jobs.
- Reduce noisy messages that ask for action before sleep, recovery, or workout data exists.
- Keep freshness and service health guardrails as safety nets.

## Non-Goals

- Do not redesign the entire Spartan coaching voice.
- Do not remove the existing WHOOP webhook ingress/audit pipeline.
- Do not remove evening, weekly, monthly, freshness, or infrastructure health jobs.
- Do not make WHOOP webhooks the only health monitor; stale-data detection still matters.

## Current Behavior

Time-based fitness crons currently include:

- Fitness Morning Brief at 8:12 AM daily.
- WHOOP Recovery Risk Alert at 9:05 AM daily.
- WHOOP Overreach Guard at 7:15 PM daily.
- Fitness Evening Recap at 8:30 PM daily.
- Weekly Fitness Insights Sunday at 8 PM.
- Monthly Fitness Overview on the first of the month at 8:05 PM.
- WHOOP freshness guard at 6:20 AM, 12:20 PM, and 6:20 PM.
- Fitness service and cron health guardrails.

The new WHOOP webhook flow already sends a lightweight Spartan Telegram precursor when WHOOP sends a live event.

## Desired Behavior

### Wake and recovery

When WHOOP sends `sleep.updated` or `recovery.updated`, the system should coalesce the related morning signals and trigger Spartan to produce one wake/recovery coaching message.

This replaces:

- Fitness Morning Brief.
- WHOOP Recovery Risk Alert.

### Workout

When WHOOP sends `workout.updated`, the system should trigger Spartan to produce one post-workout coaching message with event context.

The webhook precursor should remain as the immediate received-signal message.

### Evening recap

The evening recap remains scheduled. It should absorb the overreach-guard logic so evening coaching can warn about accumulated load, recovery risk, or overreach without a separate 7:15 PM alert.

This replaces:

- WHOOP Overreach Guard as a standalone cron.

### Long-horizon insights

Weekly and monthly insight jobs remain scheduled.

### Safety nets

The freshness guard remains scheduled and quiet on healthy paths. Its role is to detect missing or stale WHOOP data, not to duplicate coaching when live events are arriving.

## User Experience

For a workout event:

1. WHOOP sends a webhook.
2. The webhook pipeline sends the lightweight precursor message, for example `Spartan - WHOOP Live / Workout updated`.
3. Spartan receives the event artifact and generates richer coaching.
4. The richer message arrives shortly after the precursor.

For a morning recovery event:

1. WHOOP sends sleep/recovery webhook updates.
2. The webhook pipeline sends the precursor.
3. Spartan sends one wake/recovery message after the coalescing window.

## Requirements

- Preserve webhook precursor Telegram delivery.
- Trigger Spartan with a structured event artifact, not just a formatted text message.
- Coalesce related `sleep.updated` and `recovery.updated` signals into one morning analysis when they arrive close together.
- Ensure idempotency by event type and resource ID.
- Record each event-triggered coaching attempt and result.
- Keep all healthy/no-op paths quiet except the intentional webhook precursor.
- Keep the system safe if Spartan fails: webhook ingestion and audit should still succeed.

## Open Questions

- Should wake/recovery wait for both sleep and recovery when only one event arrives, or send after a bounded delay with whatever is available?
- Should post-workout coaching fetch Tonal context when the workout was not a Tonal session?
- Should Spartan use the existing `cron-fitness` agent or the dedicated `spartan` agent for event-triggered turns?

## Success Metrics

- No daily morning fitness cron message fires before WHOOP data exists.
- Real WHOOP workout events produce a precursor plus a richer Spartan coaching message.
- Real sleep/recovery events produce one coalesced wake/recovery coaching message.
- Evening recap still fires and covers overreach when relevant.
- Weekly and monthly insight jobs continue unchanged.
- WHOOP freshness guard still alerts when data is stale or missing.
