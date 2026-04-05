import type { AthleteStateDailyRow, MuscleVolumeDailyRow } from "./athlete-state-db.js";

export type DailyRecommendationMode = "push" | "controlled_train" | "zone2_technique" | "recover";

export type DailyRecommendationContext = {
  readinessBand: "green" | "yellow" | "red" | "unknown";
  readinessConfidence: number | null;
  sleepPerformance: number | null;
  whoopStrain: number | null;
  proteinTargetG: number | null;
  proteinG: number | null;
  nutritionConfidence: "high" | "medium" | "low" | null;
  qualityFlags?: Record<string, unknown> | null;
  phaseMode?: string | null;
  targetWeightDeltaPctWeek?: number | null;
  cardioMinutes?: number | null;
};

export type WeeklyMuscleDoseTarget = {
  minHardSets: number;
  maxHardSets: number;
};

export type WeeklyDoseCall = {
  muscle_group: string;
  hard_sets: number;
  target_min: number;
  target_max: number;
  status: "underdosed" | "on_target" | "overdosed";
  delta_from_min: number;
  delta_from_max: number;
};

type MuscleVolumeLike = Pick<MuscleVolumeDailyRow, "muscle_group" | "hard_sets"> & {
  muscleGroup?: string;
  hardSets?: number | null;
};

export type TrainingEngineConfig = {
  readinessConfidenceFloor: number;
  sleepPerformancePushFloor: number;
  sleepPerformanceControlFloor: number;
  highStrainThreshold: number;
  cutRateRiskFloorPct: number;
  cardioInterferenceMinutesFloor: number;
  muscleDoseTargets: Record<string, WeeklyMuscleDoseTarget>;
};

export type DailyRecommendation = {
  mode: DailyRecommendationMode;
  confidence: number;
  limitingFactor: string;
  topRisk: string;
  rationale: string;
};

export const DEFAULT_TRAINING_ENGINE_CONFIG: TrainingEngineConfig = {
  readinessConfidenceFloor: 0.5,
  sleepPerformancePushFloor: 85,
  sleepPerformanceControlFloor: 75,
  highStrainThreshold: 14,
  cutRateRiskFloorPct: -0.75,
  cardioInterferenceMinutesFloor: 45,
  muscleDoseTargets: {
    chest: { minHardSets: 8, maxHardSets: 18 },
    back: { minHardSets: 10, maxHardSets: 20 },
    quads: { minHardSets: 8, maxHardSets: 18 },
    hamstrings: { minHardSets: 6, maxHardSets: 16 },
    glutes: { minHardSets: 6, maxHardSets: 16 },
    shoulders: { minHardSets: 8, maxHardSets: 18 },
    biceps: { minHardSets: 6, maxHardSets: 14 },
    triceps: { minHardSets: 6, maxHardSets: 14 },
    calves: { minHardSets: 4, maxHardSets: 12 },
    core: { minHardSets: 4, maxHardSets: 14 },
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hasQualityFlag(flags: Record<string, unknown> | null | undefined, key: string): boolean {
  return Boolean(flags && key in flags && flags[key] !== false && flags[key] != null);
}

export function recommendationConfidence(context: DailyRecommendationContext): number {
  let score = context.readinessConfidence ?? 0.55;
  if (context.readinessBand === "unknown") score = Math.min(score, 0.45);
  if (hasQualityFlag(context.qualityFlags, "stale_provider_data")) score -= 0.2;
  if (hasQualityFlag(context.qualityFlags, "duplicate_whoop_workouts_removed")) score -= 0.1;
  if (hasQualityFlag(context.qualityFlags, "unmapped_tonal_movements")) score -= 0.1;
  if ((context.nutritionConfidence ?? "low") === "low") score -= 0.08;
  return Number(clamp(score, 0.2, 0.98).toFixed(3));
}

export function buildDailyRecommendation(
  context: DailyRecommendationContext,
  config: TrainingEngineConfig = DEFAULT_TRAINING_ENGINE_CONFIG,
): DailyRecommendation {
  const confidence = recommendationConfidence(context);
  const proteinGap =
    context.proteinTargetG != null && context.proteinG != null
      ? Number((context.proteinTargetG - context.proteinG).toFixed(2))
      : null;

  if (context.readinessBand === "red") {
    return {
      mode: "recover",
      confidence,
      limitingFactor: "recovery_tolerance",
      topRisk: "Low recovery means hard training is more likely to dig fatigue than build adaptation.",
      rationale: "Recovery is below tolerance for productive intensity.",
    };
  }

  if (context.readinessBand === "unknown" || confidence < config.readinessConfidenceFloor) {
    return {
      mode: "zone2_technique",
      confidence,
      limitingFactor: "data_quality",
      topRisk: "Weak or stale input quality makes a hard call unreliable.",
      rationale: "Data quality is not strong enough to justify aggressive progression.",
    };
  }

  if ((context.sleepPerformance ?? 100) < config.sleepPerformanceControlFloor) {
    return {
      mode: "recover",
      confidence,
      limitingFactor: "sleep_debt",
      topRisk: "Sleep debt is the limiter and makes additional load expensive.",
      rationale: "Poor sleep turns even moderate training into a recovery tax.",
    };
  }

  if (
    context.readinessBand === "yellow"
    || (context.sleepPerformance ?? 100) < config.sleepPerformancePushFloor
    || (context.whoopStrain ?? 0) >= config.highStrainThreshold
    || proteinGap == null
    || proteinGap > 0
  ) {
    return {
      mode: "controlled_train",
      confidence,
      limitingFactor: proteinGap != null && proteinGap > 0 ? "fueling_gap" : "moderate_readiness",
      topRisk: proteinGap != null && proteinGap > 0
        ? "Under-fueling will cap adaptation quality if training load rises today."
        : "Moderate readiness supports quality work, not ego volume.",
      rationale: "Conditions support training only if intensity and volume stay controlled.",
    };
  }

  return {
    mode: "push",
    confidence,
    limitingFactor: "none",
    topRisk: "Green does not mean unlimited volume; fatigue still compounds if execution drifts.",
    rationale: "Readiness, sleep, and fuel support productive progression today.",
  };
}

export function buildWeeklyDoseCalls(
  rows: MuscleVolumeLike[],
  config: TrainingEngineConfig = DEFAULT_TRAINING_ENGINE_CONFIG,
): WeeklyDoseCall[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const muscleGroup = row.muscle_group ?? row.muscleGroup ?? "";
    if (!muscleGroup) continue;
    const hardSets = row.hard_sets ?? row.hardSets ?? 0;
    totals.set(muscleGroup, Number(((totals.get(muscleGroup) ?? 0) + hardSets).toFixed(2)));
  }

  return Object.entries(config.muscleDoseTargets)
    .map(([muscleGroup, target]) => {
      const hardSets = Number((totals.get(muscleGroup) ?? 0).toFixed(2));
      const status =
        hardSets < target.minHardSets ? "underdosed" : hardSets > target.maxHardSets ? "overdosed" : "on_target";
      return {
        muscle_group: muscleGroup,
        hard_sets: hardSets,
        target_min: target.minHardSets,
        target_max: target.maxHardSets,
        status,
        delta_from_min: Number((hardSets - target.minHardSets).toFixed(2)),
        delta_from_max: Number((hardSets - target.maxHardSets).toFixed(2)),
      };
    })
    .sort((a, b) => a.muscle_group.localeCompare(b.muscle_group));
}

export function detectCutRateRisk(
  stateRows: AthleteStateDailyRow[],
  config: TrainingEngineConfig = DEFAULT_TRAINING_ENGINE_CONFIG,
): "none" | "watch" {
  if (stateRows.length === 0) return "none";
  const aggressiveCutRows = stateRows.filter((row) => row.phase_mode === "aggressive_cut" || row.phase_mode === "gentle_cut");
  const riskyRows = aggressiveCutRows.filter((row) => (row.target_weight_delta_pct_week ?? 0) <= config.cutRateRiskFloorPct);
  return riskyRows.length > 0 ? "watch" : "none";
}

export function detectCardioInterference(
  stateRows: AthleteStateDailyRow[],
  legRows: MuscleVolumeLike[],
  config: TrainingEngineConfig = DEFAULT_TRAINING_ENGINE_CONFIG,
): "none" | "watch" {
  const cardioMinutes = stateRows.reduce((sum, row) => sum + (row.cardio_minutes ?? 0), 0);
  const legHardSets = legRows
    .filter((row) => {
      const muscleGroup = row.muscle_group ?? row.muscleGroup ?? "";
      return muscleGroup === "quads" || muscleGroup === "hamstrings" || muscleGroup === "glutes";
    })
    .reduce((sum, row) => sum + (row.hard_sets ?? row.hardSets ?? 0), 0);
  return cardioMinutes >= config.cardioInterferenceMinutesFloor && legHardSets >= 18 ? "watch" : "none";
}
