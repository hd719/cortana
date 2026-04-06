export type SpartanPhaseMode = "maintenance" | "lean_gain" | "gentle_cut" | "aggressive_cut";
export type SpartanMuscleGroup =
  | "chest"
  | "back"
  | "quads"
  | "hamstrings"
  | "glutes"
  | "shoulders"
  | "biceps"
  | "triceps"
  | "calves"
  | "core";

export type SpartanWeeklySetTargetBand = {
  minHardSets: number;
  maxHardSets: number;
};

export type SpartanPhaseDefaults = {
  phaseMode: SpartanPhaseMode;
  proteinTargetG: number;
  targetWeightDeltaPctPerWeek: number;
  targetCutRatePctPerWeek: number;
  caloriesDeltaKcalPerDay: number;
  description: string;
  weeklySetTargetBands: Record<SpartanMuscleGroup, SpartanWeeklySetTargetBand>;
};

export const SPARTAN_PHASE_DEFAULTS = {
  maintenance: {
    phaseMode: "maintenance",
    proteinTargetG: 140,
    targetWeightDeltaPctPerWeek: 0,
    targetCutRatePctPerWeek: 0,
    caloriesDeltaKcalPerDay: 0,
    description: "Hold performance and bodyweight with stable intake and no intentional cut.",
    weeklySetTargetBands: {
      chest: { minHardSets: 8, maxHardSets: 14 },
      back: { minHardSets: 10, maxHardSets: 16 },
      quads: { minHardSets: 8, maxHardSets: 14 },
      hamstrings: { minHardSets: 6, maxHardSets: 12 },
      glutes: { minHardSets: 6, maxHardSets: 12 },
      shoulders: { minHardSets: 8, maxHardSets: 14 },
      biceps: { minHardSets: 6, maxHardSets: 10 },
      triceps: { minHardSets: 6, maxHardSets: 10 },
      calves: { minHardSets: 4, maxHardSets: 10 },
      core: { minHardSets: 4, maxHardSets: 10 },
    },
  },
  lean_gain: {
    phaseMode: "lean_gain",
    proteinTargetG: 150,
    targetWeightDeltaPctPerWeek: 0.15,
    targetCutRatePctPerWeek: 0,
    caloriesDeltaKcalPerDay: 150,
    description: "Support gradual hypertrophy with a small surplus and stable recovery.",
    weeklySetTargetBands: {
      chest: { minHardSets: 10, maxHardSets: 18 },
      back: { minHardSets: 12, maxHardSets: 20 },
      quads: { minHardSets: 10, maxHardSets: 18 },
      hamstrings: { minHardSets: 8, maxHardSets: 16 },
      glutes: { minHardSets: 8, maxHardSets: 16 },
      shoulders: { minHardSets: 10, maxHardSets: 18 },
      biceps: { minHardSets: 8, maxHardSets: 14 },
      triceps: { minHardSets: 8, maxHardSets: 14 },
      calves: { minHardSets: 6, maxHardSets: 12 },
      core: { minHardSets: 5, maxHardSets: 12 },
    },
  },
  gentle_cut: {
    phaseMode: "gentle_cut",
    proteinTargetG: 160,
    targetWeightDeltaPctPerWeek: -0.35,
    targetCutRatePctPerWeek: 0.35,
    caloriesDeltaKcalPerDay: -300,
    description: "Trim fat slowly while preserving strength and training quality.",
    weeklySetTargetBands: {
      chest: { minHardSets: 6, maxHardSets: 12 },
      back: { minHardSets: 8, maxHardSets: 14 },
      quads: { minHardSets: 6, maxHardSets: 12 },
      hamstrings: { minHardSets: 5, maxHardSets: 10 },
      glutes: { minHardSets: 5, maxHardSets: 10 },
      shoulders: { minHardSets: 6, maxHardSets: 12 },
      biceps: { minHardSets: 4, maxHardSets: 8 },
      triceps: { minHardSets: 4, maxHardSets: 8 },
      calves: { minHardSets: 3, maxHardSets: 8 },
      core: { minHardSets: 3, maxHardSets: 8 },
    },
  },
  aggressive_cut: {
    phaseMode: "aggressive_cut",
    proteinTargetG: 170,
    targetWeightDeltaPctPerWeek: -0.75,
    targetCutRatePctPerWeek: 0.75,
    caloriesDeltaKcalPerDay: -600,
    description: "Drive a faster cut only when body-composition change is the explicit priority.",
    weeklySetTargetBands: {
      chest: { minHardSets: 4, maxHardSets: 10 },
      back: { minHardSets: 6, maxHardSets: 12 },
      quads: { minHardSets: 4, maxHardSets: 10 },
      hamstrings: { minHardSets: 4, maxHardSets: 8 },
      glutes: { minHardSets: 4, maxHardSets: 8 },
      shoulders: { minHardSets: 4, maxHardSets: 10 },
      biceps: { minHardSets: 3, maxHardSets: 7 },
      triceps: { minHardSets: 3, maxHardSets: 7 },
      calves: { minHardSets: 2, maxHardSets: 6 },
      core: { minHardSets: 2, maxHardSets: 6 },
    },
  },
} as const satisfies Record<SpartanPhaseMode, SpartanPhaseDefaults>;

export function resolveSpartanPhaseDefaults(phaseMode: SpartanPhaseMode | null | undefined): SpartanPhaseDefaults {
  if (phaseMode && phaseMode in SPARTAN_PHASE_DEFAULTS) {
    return SPARTAN_PHASE_DEFAULTS[phaseMode as SpartanPhaseMode];
  }
  return SPARTAN_PHASE_DEFAULTS.maintenance;
}
