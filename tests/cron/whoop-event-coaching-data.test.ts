import { describe, expect, it } from "vitest";

import {
  buildSpartanCoachingReason,
  buildSpartanEventCoachingSchemaSql,
  buildWhoopCoachingIdempotencyKey,
  coachingLaneForWhoopEvent,
  localDateForEvent,
  markWhoopCoachingDelivered,
  markWhoopCoachingFailed,
  nextWhoopCoachingArtifact,
  type SpartanWhoopCoachingLane,
  type WhoopEventAnalysisCandidate,
  type WhoopEventCoachingStore,
  whoopEventLookbackMinutes,
} from "../../tools/fitness/whoop-event-coaching-data.ts";

function fakeStore(candidates: WhoopEventAnalysisCandidate[]): WhoopEventCoachingStore & { claimed: Set<string> } {
  const claimed = new Set<string>();
  return {
    claimed,
    ensureSchema: () => undefined,
    fetchCandidates: () => candidates,
    claimCandidate: (_candidate, _lane, idempotencyKey) => {
      if (claimed.has(idempotencyKey)) return false;
      claimed.add(idempotencyKey);
      return true;
    },
    markDelivered: (idempotencyKey) => claimed.has(idempotencyKey),
    markFailed: (idempotencyKey) => claimed.has(idempotencyKey),
  };
}

describe("whoop event coaching data service", () => {
  it("claims one eligible workout event, emits a coaching artifact, then dedupes the next pass", () => {
    const store = fakeStore([
      {
        trace_id: "trace-1",
        event_type: "workout.updated",
        resource_id: "workout-123",
        whoop_user_id: "user-1",
        observed_at: "2026-05-11T14:00:00.000Z",
        artifact: { summary: { headline: "Run logged" } },
        created_at: "2026-05-11T14:01:00.000Z",
      },
    ]);

    const first = nextWhoopCoachingArtifact({
      store,
      buildFitnessContext: (lane) => ({ lane, readiness: "green" }),
      now: () => new Date("2026-05-11T14:02:00.000Z"),
    });

    expect(first).toMatchObject({
      source: "whoop_webhook",
      coaching_lane: "post_workout",
      idempotency_key: "whoop:workout:user-1:workout-123",
      event_type: "workout.updated",
      fitness_context: { lane: "post_workout", readiness: "green" },
    });
    expect(first?.mark_delivered_command).toContain("--mark-delivered=whoop:workout:user-1:workout-123");
    expect(store.claimed.has("whoop:workout:user-1:workout-123")).toBe(true);

    expect(nextWhoopCoachingArtifact({
      store,
      buildFitnessContext: () => ({ should_not_run: true }),
      now: () => new Date("2026-05-11T14:03:00.000Z"),
    })).toBeNull();
  });

  it("reports missing delivery state instead of claiming success", () => {
    const store = fakeStore([]);

    expect(markWhoopCoachingDelivered({ store }, "missing-key")).toEqual({
      ok: false,
      idempotency_key: "missing-key",
      status: "missing",
    });
    expect(markWhoopCoachingFailed({ store }, "missing-key", "send failed")).toEqual({
      ok: false,
      idempotency_key: "missing-key",
      status: "missing",
    });
  });
});

describe("whoop event coaching data helpers", () => {
  it("classifies WHOOP update events into Spartan coaching lanes", () => {
    expect(coachingLaneForWhoopEvent("workout.updated")).toBe("post_workout");
    expect(coachingLaneForWhoopEvent("sleep.updated")).toBe("wake_recovery");
    expect(coachingLaneForWhoopEvent("recovery.updated")).toBe("wake_recovery");
    expect(coachingLaneForWhoopEvent("workout.deleted")).toBe("audit_only");
  });

  it("builds stable idempotency keys by coaching lane", () => {
    expect(buildWhoopCoachingIdempotencyKey({
      eventType: "workout.updated",
      resourceId: "workout-123",
      observedAt: "2026-05-11T14:00:00.000Z",
      whoopUserId: "user-1",
    })).toBe("whoop:workout:user-1:workout-123");

    expect(buildWhoopCoachingIdempotencyKey({
      eventType: "sleep.updated",
      resourceId: "sleep-123",
      observedAt: "2026-05-11T10:00:00.000Z",
      whoopUserId: "user-1",
    })).toBe("whoop:wake-recovery:user-1:2026-05-11");

    expect(buildWhoopCoachingIdempotencyKey({
      eventType: "workout.deleted",
      resourceId: "workout-123",
    })).toBeNull();
  });

  it("uses New York local dates for wake/recovery coalescing", () => {
    expect(localDateForEvent("2026-05-11T03:30:00.000Z")).toBe("2026-05-10");
    expect(localDateForEvent("2026-05-11T12:30:00.000Z")).toBe("2026-05-11");
  });

  it("keeps live-event lookback bounded while allowing env override", () => {
    expect(whoopEventLookbackMinutes({} as NodeJS.ProcessEnv)).toBe(180);
    expect(whoopEventLookbackMinutes({ SPARTAN_WHOOP_EVENT_LOOKBACK_MINUTES: "45" } as NodeJS.ProcessEnv)).toBe(45);
    expect(whoopEventLookbackMinutes({ SPARTAN_WHOOP_EVENT_LOOKBACK_MINUTES: "nope" } as NodeJS.ProcessEnv)).toBe(180);
  });

  it("documents the durable claim table needed for delivery dedupe", () => {
    const sql = buildSpartanEventCoachingSchemaSql();
    expect(sql).toContain("spartan_event_coaching_log");
    expect(sql).toContain("idempotency_key text UNIQUE NOT NULL");
    expect(sql).toContain("status IN ('claimed','delivered','failed')");
  });

  it("builds coach-facing reasons from event artifacts", () => {
    const reason = buildSpartanCoachingReason({
      lane: "post_workout" as SpartanWhoopCoachingLane,
      eventType: "workout.updated",
      artifact: { summary: { headline: "Workout updated" } },
    });

    expect(reason).toContain("Workout updated");
    expect(reason).toContain("post-workout coaching");
  });
});
