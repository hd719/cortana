# Implementation Plan: Spartan Event-Driven Coaching

## Phase 0: Confirm Current Inventory

- Confirm current cron IDs and schedules in `config/cron/jobs.json`.
- Confirm WHOOP webhook precursor still sends via `external-service`.
- Confirm WHOOP events reach `whoop_webhook_events` and `whoop_activity_log` in `cortana-external`.

Exit criteria:

- Inventory matches the PRD.
- No cron is disabled yet.

## Phase 1: Add Event Coaching Contract

- Define the event coaching artifact shape.
- Add classification for:
  - wake/recovery
  - post-workout
  - audit-only
- Add deterministic idempotency key generation.
- Add tests for classification and idempotency keys.

Exit criteria:

- Artifact construction is covered by unit tests.
- Existing webhook precursor behavior is unchanged.

## Phase 2: Build Spartan Event Runner

- Add a runner that accepts a WHOOP event artifact.
- Enrich wake/recovery events with existing morning/recovery data logic.
- Enrich workout events with WHOOP snapshot and Tonal context when available.
- Send coaching through Telegram account `spartan`.
- Record success/failure metadata.

Exit criteria:

- Runner can be invoked manually with a fixture artifact.
- Manual run sends one Spartan coaching message.
- Failures are recorded without breaking webhook ingestion.

## Phase 3: Wire Webhook Processor to Runner

- Keep existing `Spartan - WHOOP Live` precursor delivery.
- After precursor/audit, enqueue or invoke the Spartan event runner.
- Add duplicate protection so one WHOOP event does not send multiple coaching messages.
- Add integration tests for workout and wake/recovery events.

Exit criteria:

- Fake `workout.updated` event sends precursor and event coaching once.
- Duplicate event does not duplicate coaching.
- Fake sleep/recovery pair produces one wake/recovery coaching message.

## Phase 4: Fold Overreach Into Evening Recap

- Move useful overreach logic from `fitness-alerts-data.ts --types=overreach` into `evening-recap-data.ts` or a shared helper.
- Update evening recap prompt to include overreach only when it changes the recommendation.
- Add tests for evening overreach messaging.

Exit criteria:

- Evening recap can surface overreach risk.
- Standalone overreach guard is no longer needed.

## Phase 5: Disable Replaced Crons

Disable only after webhook-triggered coaching has passed manual smoke tests.

Disable:

- Fitness Morning Brief at 8:12 AM daily.
- `whoop-recovery-risk-alert-20260318`.
- `whoop-overreach-guard-20260318`.

Keep:

- Evening recap.
- Weekly insights.
- Monthly overview.
- WHOOP freshness guard.
- Fitness service healthcheck.
- Cron drain recovery.

Exit criteria:

- `config/cron/jobs.json` reflects the new operating model.
- Runtime cron state is synced.
- Mission Control/OpenClaw cron view shows the intended active jobs.

## Phase 6: End-to-End QA

Manual QA:

1. Create a short WHOOP workout.
2. Confirm the precursor Telegram message arrives.
3. Confirm the richer Spartan post-workout message arrives.
4. Confirm `whoop_webhook_events.status = processed`.
5. Confirm `whoop_activity_log.status = sent` or equivalent event-coaching status.
6. Wait for evening recap and confirm overreach logic is available when relevant.

Regression QA:

- No morning brief cron fires the next morning.
- Recovery/wake coaching occurs only after WHOOP event delivery.
- Weekly and monthly jobs still run on schedule.
- Freshness guard remains quiet on healthy paths.

## Rollback Plan

If event-driven coaching is noisy or unreliable:

1. Leave webhook precursor enabled.
2. Disable the Spartan event runner trigger.
3. Re-enable Fitness Morning Brief and Recovery Risk Alert crons.
4. Keep WHOOP `:10000` webhook route unchanged.
5. Investigate runner/idempotency failures offline.

## PR Sequence

Recommended sequence:

1. Planning docs PR.
2. Artifact/classification/idempotency PR.
3. Event runner PR.
4. Webhook integration PR.
5. Cron retirement PR after live QA.

Avoid combining all phases into one large PR.
