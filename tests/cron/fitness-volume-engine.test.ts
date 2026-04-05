import { describe, expect, it } from "vitest";

import { resolveSpartanPhaseDefaults } from "../../tools/fitness/spartan-defaults.ts";
import {
  buildWeeklyMuscleDoseAssessments,
  classifyWeeklyMuscleDose,
} from "../../tools/fitness/volume-engine.ts";

describe("fitness volume engine", () => {
  it("exposes phase-aware weekly set bands by muscle group", () => {
    const maintenance = resolveSpartanPhaseDefaults("maintenance");
    const leanGain = resolveSpartanPhaseDefaults("lean_gain");
    const aggressiveCut = resolveSpartanPhaseDefaults("aggressive_cut");

    expect(maintenance.weeklySetTargetBands.chest).toEqual({ minHardSets: 8, maxHardSets: 14 });
    expect(leanGain.weeklySetTargetBands.back).toEqual({ minHardSets: 12, maxHardSets: 20 });
    expect(aggressiveCut.weeklySetTargetBands.core).toEqual({ minHardSets: 2, maxHardSets: 6 });
  });

  it("classifies a weekly muscle dose as underdosed, adequate, overdosed, or unknown", () => {
    const underdosed = classifyWeeklyMuscleDose({
      phaseMode: "maintenance",
      muscleGroup: "chest",
      hardSets: 6,
    });
    const adequate = classifyWeeklyMuscleDose({
      phaseMode: "lean_gain",
      muscleGroup: "back",
      hardSets: 16,
    });
    const overdosed = classifyWeeklyMuscleDose({
      phaseMode: "aggressive_cut",
      muscleGroup: "shoulders",
      hardSets: 12,
    });
    const unknown = classifyWeeklyMuscleDose({
      phaseMode: "unknown",
      muscleGroup: "quads",
      hardSets: 10,
    });

    expect(underdosed.status).toBe("underdosed");
    expect(underdosed.rationale).toContain("maintenance band");
    expect(adequate.status).toBe("adequate");
    expect(adequate.confidence).toBeGreaterThan(0.8);
    expect(overdosed.status).toBe("overdosed");
    expect(overdosed.rationale).toContain("aggressive_cut band");
    expect(unknown.status).toBe("unknown");
    expect(unknown.rationale).toContain("Phase mode is unknown");
  });

  it("aggregates weekly rows and keeps missing muscle groups explicit", () => {
    const assessments = buildWeeklyMuscleDoseAssessments({
      phaseMode: "maintenance",
      rows: [
        { muscle_group: "chest", hard_sets: 3 } as const,
        { muscle_group: "chest", hard_sets: 5 } as const,
        { muscle_group: "back", hard_sets: 17 } as const,
        { muscle_group: "neck", hard_sets: 4 } as const,
      ],
      includeUnknownMuscleGroups: true,
    });

    const chest = assessments.find((assessment) => assessment.muscleGroup === "chest");
    const back = assessments.find((assessment) => assessment.muscleGroup === "back");
    const neck = assessments.find((assessment) => assessment.muscleGroup === "neck");
    const quads = assessments.find((assessment) => assessment.muscleGroup === "quads");

    expect(chest?.status).toBe("adequate");
    expect(chest?.hardSets).toBe(8);
    expect(chest?.rowCount).toBe(2);
    expect(back?.status).toBe("overdosed");
    expect(neck?.status).toBe("unknown");
    expect(neck?.rationale).toContain("No target band is configured");
    expect(quads?.status).toBe("unknown");
    expect(quads?.rationale).toContain("No weekly hard-set rows were recorded");
  });
});

