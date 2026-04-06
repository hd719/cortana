import { describe, expect, it } from "vitest";
import { evaluateMonthlyOutcome, evaluateWeeklyOutcome } from "../../tools/fitness/outcome-eval.ts";

describe("fitness outcome evaluation", () => {
  it("scores a strong week higher than a sparse week", () => {
    const strong = evaluateWeeklyOutcome({
      isoLabel: "2026-W14",
      periodStart: "2026-03-30",
      periodEnd: "2026-04-05",
      plannedTrainingDays: 5,
      completedTrainingDays: 5,
      missedTrainingDays: 0,
      recoveryDaysLogged: 6,
      sleepDaysLogged: 6,
      proteinDaysLogged: 6,
      proteinDaysOnTarget: 5,
      avgRecovery: 72,
      avgSleepHours: 7.8,
      avgProteinG: 126,
      tonalSessions: 4,
      tonalVolume: 68500,
      tonalVolumeDeltaPct: 8,
      whoopStrainDeltaPct: -3,
      painDays: 0,
      scheduleConflicts: 0,
      overreachAlerts: 0,
      staleDataDays: 0,
      performanceTrend: "improving",
      readinessBand: "green",
    });

    const sparse = evaluateWeeklyOutcome({
      isoLabel: "2026-W14",
      periodStart: "2026-03-30",
      periodEnd: "2026-04-05",
      plannedTrainingDays: 5,
      completedTrainingDays: 2,
      missedTrainingDays: 3,
      recoveryDaysLogged: 1,
      sleepDaysLogged: 1,
      proteinDaysLogged: 0,
      proteinDaysOnTarget: 0,
      avgRecovery: null,
      avgSleepHours: null,
      avgProteinG: null,
      tonalSessions: 0,
      tonalVolume: null,
      tonalVolumeDeltaPct: null,
      whoopStrainDeltaPct: 7,
      painDays: 2,
      scheduleConflicts: 1,
      overreachAlerts: 2,
      staleDataDays: 2,
      performanceTrend: "unknown",
      readinessBand: "yellow",
    });

    expect(strong.overall_score).toBeGreaterThan(sparse.overall_score);
    expect(strong.confidence).toBe("high");
    expect(strong.wins).toContain("Training follow-through stayed strong.");
    expect(sparse.confidence).toBe("low");
    expect(sparse.caveats.length).toBeGreaterThan(0);
    expect(sparse.caveats.join(" ")).toContain("Protein adherence is unobserved");
  });

  it("supports monthly outcome evaluation with the same deterministic scorer", () => {
    const monthly = evaluateMonthlyOutcome({
      isoLabel: "2026-04",
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      plannedTrainingDays: 20,
      completedTrainingDays: 17,
      recoveryDaysLogged: 18,
      sleepDaysLogged: 19,
      proteinDaysLogged: 16,
      proteinDaysOnTarget: 13,
      avgRecovery: 68,
      avgSleepHours: 7.5,
      avgProteinG: 121,
      tonalSessions: 14,
      tonalVolume: 248000,
      tonalVolumeDeltaPct: 4,
      whoopStrainDeltaPct: 1,
      painDays: 1,
      scheduleConflicts: 1,
      overreachAlerts: 1,
      staleDataDays: 0,
      performanceTrend: "stable",
      readinessBand: "green",
    });

    expect(monthly.period).toBe("monthly");
    expect(monthly.overall_score).toBeGreaterThan(60);
    expect(monthly.component_scores.performance_alignment).toBeGreaterThan(0);
  });
});
