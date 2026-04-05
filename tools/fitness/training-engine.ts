import type { AthleteStateDailyRow, MuscleVolumeDailyRow } from "./athlete-state-db.js";
import { buildWeeklyMuscleDoseAssessments } from "./volume-engine.js";

export type DailyRecommendationMode = "push" | "controlled_train" | "zone2_technique" | "recover";
export type CardioMode = "walk" | "cycle" | "run" | "hiit" | "mixed" | "other";

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
  weeklyFatigueScore?: number | null;
  weeklyProgressionScore?: number | null;
  weeklyInterferenceRiskScore?: number | null;
  weeklyRecommendationMode?: string | null;
  underdosedMusclesCount?: number | null;
  overdosedMusclesCount?: number | null;
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
  status: "underdosed" | "on_target" | "overdosed" | "unknown";
  delta_from_min: number | null;
  delta_from_max: number | null;
  confidence?: number;
  rationale?: string;
};

type MuscleVolumeLike = Pick<MuscleVolumeDailyRow, "muscle_group" | "hard_sets"> & {
  muscleGroup?: string;
  hardSets?: number | null;
  source_confidence?: number | null;
  sourceConfidence?: number | null;
};

export type CardioModeSummary = {
  total_minutes: number;
  by_mode_minutes: Record<CardioMode, number>;
  dominant_mode: CardioMode;
};

export type CardioInterferenceAssessment = {
  status: "none" | "watch";
  score: number;
  dominant_mode: CardioMode;
  lower_body_hard_sets: number;
  cardio_minutes: number;
  rationale: string;
};

export type TrainingEngineConfig = {
  readinessConfidenceFloor: number;
  sleepPerformancePushFloor: number;
  sleepPerformanceControlFloor: number;
  highStrainThreshold: number;
  cutRateRiskFloorPct: number;
  cardioInterferenceMinutesFloor: number;
  deloadFatigueScoreFloor: number;
  highInterferenceScore: number;
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
  deloadFatigueScoreFloor: 24,
  highInterferenceScore: 70,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function hasQualityFlag(flags: Record<string, unknown> | null | undefined, key: string): boolean {
  return Boolean(flags && key in flags && flags[key] !== false && flags[key] != null);
}

function inferCardioModeFromSportName(sport: string): CardioMode {
  const normalized = sport.trim().toLowerCase();
  if (!normalized) return "other";
  if (normalized.includes("walk") || normalized.includes("hike")) return "walk";
  if (normalized.includes("cycle") || normalized.includes("ride") || normalized.includes("bike")) return "cycle";
  if (normalized.includes("run") || normalized.includes("jog")) return "run";
  if (normalized.includes("hiit") || normalized.includes("interval") || normalized.includes("conditioning")) return "hiit";
  return "other";
}

export function buildCardioModeSummary(stateRows: AthleteStateDailyRow[]): CardioModeSummary {
  const byMode: Record<CardioMode, number> = {
    walk: 0,
    cycle: 0,
    run: 0,
    hiit: 0,
    mixed: 0,
    other: 0,
  };

  let totalMinutes = 0;
  for (const row of stateRows) {
    totalMinutes += row.cardio_minutes ?? 0;
    const bySport = (row.cardio_summary?.by_sport_minutes as Record<string, unknown> | undefined) ?? {};
    let rowHasSpecificMode = false;
    for (const [sportName, rawMinutes] of Object.entries(bySport)) {
      const minutes = typeof rawMinutes === "number" && Number.isFinite(rawMinutes) ? rawMinutes : 0;
      if (minutes <= 0) continue;
      rowHasSpecificMode = true;
      byMode[inferCardioModeFromSportName(sportName)] = round(byMode[inferCardioModeFromSportName(sportName)] + minutes);
    }
    if (!rowHasSpecificMode && (row.cardio_minutes ?? 0) > 0) {
      byMode.mixed = round(byMode.mixed + (row.cardio_minutes ?? 0));
    }
  }

  const dominantEntry = (Object.entries(byMode) as Array<[CardioMode, number]>)
    .sort((a, b) => b[1] - a[1])[0] ?? ["other", 0];

  return {
    total_minutes: round(totalMinutes),
    by_mode_minutes: byMode,
    dominant_mode: dominantEntry[1] > 0 ? dominantEntry[0] : "other",
  };
}

function lowerBodyHardSets(rows: MuscleVolumeLike[]): number {
  return rows
    .filter((row) => {
      const muscleGroup = row.muscle_group ?? row.muscleGroup ?? "";
      return muscleGroup === "quads" || muscleGroup === "hamstrings" || muscleGroup === "glutes";
    })
    .reduce((sum, row) => sum + (row.hard_sets ?? row.hardSets ?? 0), 0);
}

export function buildCardioInterferenceAssessment(
  stateRows: AthleteStateDailyRow[],
  legRows: MuscleVolumeLike[],
  config: TrainingEngineConfig = DEFAULT_TRAINING_ENGINE_CONFIG,
): CardioInterferenceAssessment {
  const cardio = buildCardioModeSummary(stateRows);
  const legHardSets = lowerBodyHardSets(legRows);
  let score = 0;

  score += Math.min(40, cardio.by_mode_minutes.run * 0.8);
  score += Math.min(35, cardio.by_mode_minutes.hiit * 0.9);
  score += Math.min(18, cardio.by_mode_minutes.cycle * 0.25);
  score += Math.min(10, cardio.by_mode_minutes.walk * 0.08);
  score += Math.min(28, cardio.by_mode_minutes.mixed * 0.45);
  score += Math.max(0, legHardSets - 12) * 1.8;
  if (cardio.total_minutes >= config.cardioInterferenceMinutesFloor) score += 10;
  score = round(clamp(score, 0, 100));

  const status = score >= 45 ? "watch" : "none";
  const rationale =
    status === "watch"
      ? `${cardio.dominant_mode} cardio and ${legHardSets.toFixed(1)} lower-body hard sets create meaningful interference risk.`
      : `Cardio mode and lower-body volume are still compatible this week.`;

  return {
    status,
    score,
    dominant_mode: cardio.dominant_mode,
    lower_body_hard_sets: round(legHardSets),
    cardio_minutes: cardio.total_minutes,
    rationale,
  };
}

export function recommendationConfidence(context: DailyRecommendationContext): number {
  let score = context.readinessConfidence ?? 0.55;
  if (context.readinessBand === "unknown") score = Math.min(score, 0.45);
  if (hasQualityFlag(context.qualityFlags, "stale_provider_data")) score -= 0.2;
  if (hasQualityFlag(context.qualityFlags, "duplicate_whoop_workouts_removed")) score -= 0.1;
  if (hasQualityFlag(context.qualityFlags, "unmapped_tonal_movements")) score -= 0.1;
  if ((context.nutritionConfidence ?? "low") === "low") score -= 0.08;
  if ((context.weeklyFatigueScore ?? 0) >= 24) score -= 0.08;
  if ((context.weeklyInterferenceRiskScore ?? 0) >= 70) score -= 0.05;
  return round(clamp(score, 0.2, 0.98), 3);
}

export function buildDailyRecommendation(
  context: DailyRecommendationContext,
  config: TrainingEngineConfig = DEFAULT_TRAINING_ENGINE_CONFIG,
): DailyRecommendation {
  const confidence = recommendationConfidence(context);
  const proteinGap =
    context.proteinTargetG != null && context.proteinG != null
      ? round(context.proteinTargetG - context.proteinG)
      : null;

  if (context.weeklyRecommendationMode === "deload" || (context.weeklyFatigueScore ?? 0) >= config.deloadFatigueScoreFloor) {
    return {
      mode: "recover",
      confidence,
      limitingFactor: "fatigue_debt",
      topRisk: "Weekly fatigue debt is already too high to justify more overload today.",
      rationale: "The weekly state is already pointing toward deload or recovery emphasis.",
    };
  }

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
    (context.weeklyInterferenceRiskScore ?? 0) >= config.highInterferenceScore ||
    (context.overdosedMusclesCount ?? 0) > (context.underdosedMusclesCount ?? 0) + 1
  ) {
    return {
      mode: "controlled_train",
      confidence,
      limitingFactor: "weekly_load_balance",
      topRisk: "Weekly volume or interference is already elevated, so another hard push risks junk fatigue.",
      rationale: "The weekly state supports quality work, not additional volume accumulation.",
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
    rationale: "Readiness, sleep, fuel, and weekly context support productive progression today.",
  };
}

export function buildWeeklyDoseCalls(rows: MuscleVolumeLike[], phaseMode: string | null = "maintenance"): WeeklyDoseCall[] {
  return buildWeeklyMuscleDoseAssessments({
    phaseMode: phaseMode === "maintenance" || phaseMode === "lean_gain" || phaseMode === "gentle_cut" || phaseMode === "aggressive_cut"
      ? phaseMode
      : "unknown",
    rows,
    includeUnknownMuscleGroups: false,
  }).map((assessment) => ({
    muscle_group: assessment.muscleGroup,
    hard_sets: assessment.hardSets ?? 0,
    target_min: assessment.targetBand?.minHardSets ?? 0,
    target_max: assessment.targetBand?.maxHardSets ?? 0,
    status: assessment.status === "adequate" ? "on_target" : assessment.status,
    delta_from_min: assessment.deltaFromMin,
    delta_from_max: assessment.deltaFromMax,
    confidence: assessment.confidence,
    rationale: assessment.rationale,
  }));
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
  return buildCardioInterferenceAssessment(stateRows, legRows, config).status;
}
