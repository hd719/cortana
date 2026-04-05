export type SpartanPhaseMode = "maintenance" | "lean_gain" | "gentle_cut" | "aggressive_cut";

export type SpartanPhaseDefaults = {
  phaseMode: SpartanPhaseMode;
  proteinTargetG: number;
  targetWeightDeltaPctPerWeek: number;
  targetCutRatePctPerWeek: number;
  caloriesDeltaKcalPerDay: number;
  description: string;
};

export const SPARTAN_PHASE_DEFAULTS = {
  maintenance: {
    phaseMode: "maintenance",
    proteinTargetG: 140,
    targetWeightDeltaPctPerWeek: 0,
    targetCutRatePctPerWeek: 0,
    caloriesDeltaKcalPerDay: 0,
    description: "Hold performance and bodyweight with stable intake and no intentional cut.",
  },
  lean_gain: {
    phaseMode: "lean_gain",
    proteinTargetG: 150,
    targetWeightDeltaPctPerWeek: 0.15,
    targetCutRatePctPerWeek: 0,
    caloriesDeltaKcalPerDay: 150,
    description: "Support gradual hypertrophy with a small surplus and stable recovery.",
  },
  gentle_cut: {
    phaseMode: "gentle_cut",
    proteinTargetG: 160,
    targetWeightDeltaPctPerWeek: -0.35,
    targetCutRatePctPerWeek: 0.35,
    caloriesDeltaKcalPerDay: -300,
    description: "Trim fat slowly while preserving strength and training quality.",
  },
  aggressive_cut: {
    phaseMode: "aggressive_cut",
    proteinTargetG: 170,
    targetWeightDeltaPctPerWeek: -0.75,
    targetCutRatePctPerWeek: 0.75,
    caloriesDeltaKcalPerDay: -600,
    description: "Drive a faster cut only when body-composition change is the explicit priority.",
  },
} as const satisfies Record<SpartanPhaseMode, SpartanPhaseDefaults>;

export function resolveSpartanPhaseDefaults(phaseMode: SpartanPhaseMode | null | undefined): SpartanPhaseDefaults {
  if (phaseMode && phaseMode in SPARTAN_PHASE_DEFAULTS) {
    return SPARTAN_PHASE_DEFAULTS[phaseMode as SpartanPhaseMode];
  }
  return SPARTAN_PHASE_DEFAULTS.maintenance;
}
