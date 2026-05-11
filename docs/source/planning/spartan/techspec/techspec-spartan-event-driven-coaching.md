# Tech Spec: Spartan Event-Driven Coaching

## System Boundary

This work crosses two repositories:

- `cortana-external` owns WHOOP webhook ingress, processing, audit, and the lightweight Telegram precursor.
- `cortana` owns Spartan prompt doctrine, cron configuration, and event-driven coaching execution.

## Current Components

### `cortana-external`

- `apps/external-service/src/whoop/webhook-routes.ts` receives WHOOP events.
- `apps/external-service/src/whoop/webhook-store.ts` stores events, audit rows, analysis rows, and activity log rows.
- `apps/external-service/src/whoop/webhook-processor.ts` builds a `WhoopLiveEventArtifact` and processes due events.
- `apps/external-service/src/whoop/webhook-telegram.ts` sends the lightweight `Spartan - WHOOP Live` precursor.

### `cortana`

- `config/cron/jobs.json` defines fitness crons.
- `tools/fitness/morning-brief-data.ts` powers the current morning brief.
- `tools/fitness/fitness-alerts-data.ts --types=recovery_risk` powers the current recovery-risk alert.
- `tools/fitness/fitness-alerts-data.ts --types=overreach` powers the current overreach guard.
- `tools/fitness/evening-recap-data.ts` powers evening recap.
- `identities/spartan/VOICE.md` controls Spartan style.

## Proposed Architecture

Add an event-triggered coaching path after the webhook precursor.

```text
WHOOP webhook
  -> external-service verifies and stores event
  -> external-service sends lightweight precursor Telegram message
  -> external-service creates event artifact
  -> Spartan event runner receives artifact
  -> Spartan generates coaching message
  -> result is recorded for audit/idempotency
```

The precursor remains intentionally separate from the richer coaching message.

## Event Classification

| Event | Coaching lane | Behavior |
| --- | --- | --- |
| `sleep.updated` | wake/recovery | coalesce with recovery when close in time |
| `recovery.updated` | wake/recovery | coalesce with sleep when close in time |
| `workout.updated` | post-workout | trigger post-workout coaching |
| `workout.deleted` | audit | no coaching by default |
| unsupported events | audit | no coaching by default |

## Coalescing

Use a bounded coalescing window so update storms do not create duplicate coaching.

Recommended defaults:

- 45-90 seconds for workout updates.
- 2-5 minutes for sleep/recovery pairing, or send after the first event if the paired signal is already available in the WHOOP snapshot.

Coalescing keys:

- wake/recovery: `whoop_user_id + local_date + coaching_lane`
- workout: `whoop_user_id + resource_id + event_type`

## Idempotency

Every event-triggered coaching attempt should have a deterministic key.

Examples:

- `whoop:wake-recovery:<whoop_user_id>:<local_date>`
- `whoop:workout:<whoop_user_id>:<resource_id>`

Duplicate events should update audit/activity state but should not send duplicate Spartan coaching messages.

## Spartan Trigger Contract

The runner should accept a JSON artifact from the webhook processor.

Minimum artifact fields:

```json
{
  "source": "whoop-webhook",
  "event_type": "workout.updated",
  "resource_id": "...",
  "whoop_user_id": "...",
  "observed_at": "...",
  "activity_type": "workout",
  "signals": {},
  "coalesced_count": 0,
  "coaching_lane": "post_workout"
}
```

The runner should enrich the artifact with current Spartan context from existing fitness data tools before prompting Spartan.

Suggested enrichment:

- Wake/recovery: reuse or factor logic from `morning-brief-data.ts` and recovery-risk alert data.
- Post-workout: use WHOOP snapshot plus Tonal context when available.
- Evening overreach: fold the relevant `fitness-alerts-data.ts --types=overreach` output into `evening-recap-data.ts`.

## Delivery Contract

- The webhook precursor is sent by `external-service` immediately after processing starts.
- The richer Spartan coaching message is sent by the event runner.
- Spartan coaching should use Telegram account `spartan` and target `8171372724`.
- If Spartan coaching fails, mark the coaching attempt failed but do not roll back webhook ingestion.

## Cron Changes

Disable or remove these standalone jobs after event-driven equivalents are validated:

- Fitness Morning Brief at 8:12 AM daily.
- `whoop-recovery-risk-alert-20260318`.
- `whoop-overreach-guard-20260318` after its logic is folded into evening recap.

Keep these:

- Evening recap.
- Weekly insights.
- Monthly overview.
- WHOOP freshness guard.
- Fitness service healthcheck.
- Cron drain recovery.

## Observability

Record at least:

- received event trace ID
- coaching lane
- idempotency key
- precursor status
- Spartan trigger status
- Spartan Telegram delivery status
- failure reason if any

Mission Control can later show live WHOOP event activity and coaching status from these records.

## Failure Handling

- Webhook signature failure: reject and audit; do not trigger Spartan.
- Duplicate WHOOP event: audit duplicate; do not send duplicate Spartan coaching.
- Spartan runner failure: mark failed and preserve precursor/activity log.
- Telegram failure: mark failed and retain artifact for replay.
- WHOOP snapshot stale or unavailable: send conservative coaching only if enough event context exists; otherwise mark as degraded and avoid confident recommendations.

## Security

- WHOOP webhook stays public only on the dedicated Funnel URL.
- Spartan event runner should not expose a public endpoint unless it verifies an internal token or runs through an internal queue/process.
- Do not rely on unsigned public HTTP calls to trigger Spartan coaching.

## Test Strategy

Unit tests:

- event classification
- coalescing key generation
- idempotency behavior
- cron disable/fold inventory
- Spartan artifact construction

Integration tests:

- fake `workout.updated` event creates precursor and queues Spartan coaching
- duplicate `workout.updated` does not duplicate coaching
- `sleep.updated` and `recovery.updated` coalesce into one wake/recovery message
- overreach data appears in evening recap when relevant

Manual smoke:

- Create a short WHOOP workout.
- Verify webhook precursor.
- Verify richer Spartan post-workout message.
- Verify DB/activity log status.
