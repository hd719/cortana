import { describe, expect, it } from "vitest";

import {
  buildSpartanCoachingReason,
  buildSpartanEventCoachingSchemaSql,
  buildWhoopCoachingIdempotencyKey,
  coachingLaneForWhoopEvent,
  localDateForEvent,
  whoopEventLookbackMinutes,
} from "../../tools/fitness/whoop-event-coaching-data.ts";

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
      lane: "post_workout",
      eventType: "workout.updated",
      artifact: { summary: { headline: "Workout updated" } },
    });

    expect(reason).toContain("Workout updated");
    expect(reason).toContain("post-workout coaching");
  });
});
