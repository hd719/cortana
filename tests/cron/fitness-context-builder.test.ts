import { describe, expect, it } from "vitest";
import { buildFitnessContext } from "../../tools/fitness/context-builder.ts";

describe("fitness context builder", () => {
  it("builds a normalized context from provider inputs", () => {
    const ctx = buildFitnessContext({
      today: "2026-04-24",
      generatedAt: "2026-04-24T10:00:00Z",
      whoop: { recoveryScore: 72, sleepPerformance: 88, workoutsToday: [{}] },
      tonal: { healthy: true, workoutsToday: [{}, {}], volumeToday: 12000 },
      nutrition: { proteinGrams: 130, loggedMeals: 3 },
    });
    expect(ctx.readiness.band).toBe("green");
    expect(ctx.training).toMatchObject({ tonal_healthy: true, tonal_sessions_today: 2, tonal_volume_today: 12000, whoop_workouts_today: 1 });
    expect(ctx.quality.status).toBe("ok");
  });

  it("degrades conservatively when provider data is missing or stale", () => {
    const ctx = buildFitnessContext({ today: "2026-04-24", generatedAt: "now", whoop: { stale: true }, tonal: { healthy: false } });
    expect(ctx.readiness.band).toBe("unknown");
    expect(ctx.training.tonal_sessions_today).toBe(0);
    expect(ctx.quality.status).toBe("degraded");
    expect(ctx.quality.errors).toEqual(expect.arrayContaining(["whoop_stale", "whoop_recovery_missing", "tonal_not_healthy"]));
  });
});
