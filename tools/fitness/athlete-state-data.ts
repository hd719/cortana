import type { AthleteStateDailyInput, AthleteStatePhaseMode, MuscleVolumeDailyInput } from "./athlete-state-db.js";
import type { CoachNutritionRow } from "./coach-db.js";
import { buildWeeklyBodyWeightTrend, selectPreferredMetricForDate } from "./body-composition-engine.js";
import { buildFatigueDailyContribution } from "./fatigue-engine.js";
import { assessGoalModeProgress } from "./goal-mode.js";
import type { HealthSourceDailyRow } from "./health-source-db.js";
import { summarizeMealRollup, type MealEntry } from "./meal-log.js";
import {
  buildReadinessSignal,
  computeTrend,
  dataFreshnessHours,
  extractDailyStepCount,
  extractRecoveryEntries,
  extractSleepEntries,
  extractTonalSetActivities,
  extractWhoopWorkouts,
  tonalTodayWorkouts,
  tonalWorkoutsFromPayload,
  type ReadinessSignal,
  type TonalSetActivity,
} from "./signal-utils.js";
import { resolveSpartanPhaseDefaults, type SpartanPhaseMode } from "./spartan-defaults.js";

type JsonObject = Record<string, unknown>;

export type AthleteStateBuildInput = {
  stateDate: string;
  generatedAt?: string | null;
  whoopPayload: unknown;
  tonalPayload: unknown;
  mealEntries: MealEntry[];
  coachNutrition?: CoachNutritionRow | null;
  phaseMode?: SpartanPhaseMode | "unknown" | null;
  bodyWeightKg?: number | null;
  healthSourceRows?: HealthSourceDailyRow[];
  timeZone?: string;
};

export type AthleteStateBuildResult = {
  athleteState: AthleteStateDailyInput;
  muscleVolumeRows: MuscleVolumeDailyInput[];
  readinessSignal: ReadinessSignal;
  todayWhoopWorkoutStrain: number;
  yesterdayWhoopWorkoutStrain: number;
};

function toObj(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/[^0-9.+-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIsoDate(time: string | null, timeZone = "America/New_York"): string {
  if (!time) return "";
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return String(time).slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function daysBefore(dateYmd: string, days: number): string {
  const anchor = new Date(`${dateYmd}T12:00:00Z`);
  if (Number.isNaN(anchor.getTime())) return dateYmd;
  anchor.setUTCDate(anchor.getUTCDate() - days);
  return anchor.toISOString().slice(0, 10);
}

function round(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function roundSum(values: Array<number | null | undefined>, digits = 2): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return null;
  return Number(nums.reduce((sum, value) => sum + value, 0).toFixed(digits));
}

function average(values: Array<number | null | undefined>, digits = 3): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return null;
  return Number((nums.reduce((sum, value) => sum + value, 0) / nums.length).toFixed(digits));
}

function selectionConfidence(values: Array<number | null | undefined>): number | null {
  return average(values, 3);
}

function boolFlagCount(flags: TonalSetActivity[], predicate: (value: TonalSetActivity) => boolean): number {
  return flags.reduce((count, value) => count + (predicate(value) ? 1 : 0), 0);
}

function readWhoopQuality(payload: unknown): JsonObject {
  return toObj(toObj(payload).quality);
}

function cardioModeFromSportName(sportName: string): "walk" | "cycle" | "run" | "hiit" | "other" {
  const normalized = sportName.trim().toLowerCase();
  if (!normalized) return "other";
  if (normalized.includes("walk") || normalized.includes("hike")) return "walk";
  if (normalized.includes("cycle") || normalized.includes("ride") || normalized.includes("bike")) return "cycle";
  if (normalized.includes("run") || normalized.includes("jog")) return "run";
  if (normalized.includes("hiit") || normalized.includes("interval") || normalized.includes("conditioning")) return "hiit";
  return "other";
}

function cardioDurationMinutes(payload: unknown, stateDate: string, timeZone = "America/New_York"): {
  totalMinutes: number | null;
  summary: JsonObject;
} {
  const cardioSports = ["run", "ride", "cycle", "bike", "walk", "hike", "row", "swim", "cardio", "conditioning"];
  const workouts = Array.isArray(toObj(payload).workouts) ? (toObj(payload).workouts as unknown[]) : [];
  const bySport = new Map<string, number>();
  const byMode = new Map<string, number>();
  let totalMinutes = 0;
  let matched = 0;

  for (const item of workouts) {
    const row = toObj(item);
    const sportName = String(row.sport_name ?? row.sport ?? "").trim().toLowerCase();
    const start = typeof row.start === "string" ? row.start : null;
    const end = typeof row.end === "string" ? row.end : null;
    const isCardio = cardioSports.some((fragment) => sportName.includes(fragment));
    if (!isCardio || toIsoDate(start, timeZone) !== stateDate) continue;

    let minutes = toNumber(row.duration_minutes);
    if (minutes == null) {
      const durationMs = toNumber(row.duration_milli) ?? toNumber(row.durationMs);
      if (durationMs != null) minutes = durationMs / 60000;
    }
    if (minutes == null && start && end) {
      const deltaMs = new Date(end).getTime() - new Date(start).getTime();
      if (Number.isFinite(deltaMs) && deltaMs > 0) minutes = deltaMs / 60000;
    }
    if (minutes == null) continue;

    matched += 1;
    totalMinutes += minutes;
    bySport.set(sportName || "unknown", Number(((bySport.get(sportName || "unknown") ?? 0) + minutes).toFixed(2)));
    const cardioMode = cardioModeFromSportName(sportName);
    byMode.set(cardioMode, Number(((byMode.get(cardioMode) ?? 0) + minutes).toFixed(2)));
  }

  return {
    totalMinutes: matched > 0 ? Number(totalMinutes.toFixed(2)) : null,
    summary: {
      sessions: matched,
      by_sport_minutes: Object.fromEntries(bySport.entries()),
      by_mode_minutes: Object.fromEntries(byMode.entries()),
    },
  };
}

function buildDailyProgressionMomentum(input: {
  tonalVolume: number | null;
  tonalSessions: number | null;
  readinessScore: number | null;
  sleepPerformance: number | null;
  fatigueDebt: number;
}): number {
  const score =
    ((input.tonalVolume ?? 0) / 3000)
    + ((input.tonalSessions ?? 0) * 1.5)
    + Math.max(0, ((input.readinessScore ?? 60) - 60) / 8)
    + Math.max(0, ((input.sleepPerformance ?? 75) - 75) / 10)
    - (input.fatigueDebt * 0.75);
  return Number(Math.max(-20, Math.min(20, score)).toFixed(2));
}

function extractBodyWeightKg(payload: unknown): number | null {
  const body = toObj(toObj(payload).body_measurement);
  const directKg =
    toNumber(body.weight_kg) ??
    toNumber(body.weightKg) ??
    toNumber(body.body_weight_kg) ??
    toNumber(body.mass_kg);
  if (directKg != null) return round(directKg, 2);

  const pounds =
    toNumber(body.weight_lb) ??
    toNumber(body.weight_lbs) ??
    toNumber(body.weight_pounds) ??
    toNumber(body.body_weight_lb);
  if (pounds == null) return null;
  return round(pounds * 0.45359237, 2);
}

function normalizePhaseMode(
  explicitPhaseMode: AthleteStateBuildInput["phaseMode"],
  coachNutrition: CoachNutritionRow | null | undefined,
): AthleteStatePhaseMode {
  const candidate = explicitPhaseMode ?? coachNutrition?.phase_mode ?? null;
  if (
    candidate === "maintenance"
    || candidate === "lean_gain"
    || candidate === "gentle_cut"
    || candidate === "aggressive_cut"
  ) {
    return candidate;
  }
  return "unknown";
}

function deriveNutritionConfidence(mealsLogged: number, coachNutrition: CoachNutritionRow | null | undefined): "high" | "medium" | "low" {
  if (coachNutrition?.confidence === "high" || coachNutrition?.confidence === "medium" || coachNutrition?.confidence === "low") {
    return coachNutrition.confidence;
  }
  if (mealsLogged >= 3) return "high";
  if (mealsLogged >= 1) return "medium";
  return "low";
}

function inferProteinTargetG(phaseMode: AthleteStatePhaseMode, coachNutrition: CoachNutritionRow | null | undefined): number | null {
  if (coachNutrition?.protein_target_g != null) return coachNutrition.protein_target_g;
  if (phaseMode === "unknown") return null;
  return resolveSpartanPhaseDefaults(phaseMode).proteinTargetG;
}

function inferWeightDeltaTarget(phaseMode: AthleteStatePhaseMode): number | null {
  if (phaseMode === "unknown") return null;
  return resolveSpartanPhaseDefaults(phaseMode).targetWeightDeltaPctPerWeek;
}

function loadBucketSummary(sets: TonalSetActivity[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const set of sets) {
    out[set.loadBucket] = (out[set.loadBucket] ?? 0) + 1;
  }
  return out;
}

function repBucketSummary(sets: TonalSetActivity[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const set of sets) {
    out[set.repBucket] = (out[set.repBucket] ?? 0) + 1;
  }
  return out;
}

function resolveTodayTonalSets(payload: unknown, stateDate: string, timeZone = "America/New_York"): TonalSetActivity[] {
  const todayWorkouts = tonalTodayWorkouts(payload, stateDate, timeZone);
  const todayIds = new Set(todayWorkouts.map((workout) => workout.id));
  return tonalWorkoutsFromPayload(payload)
    .filter((workout) => todayIds.has(String(workout.id ?? workout.activityId ?? "")))
    .flatMap((workout) => extractTonalSetActivities({ workouts: [workout] }).map((set) => ({
      ...set,
      workoutId: set.workoutId ?? String(workout.id ?? workout.activityId ?? ""),
    })));
}

export function buildMuscleVolumeRowsForDate(input: {
  stateDate: string;
  tonalPayload: unknown;
  timeZone?: string;
}): {
  rows: MuscleVolumeDailyInput[];
  setActivities: TonalSetActivity[];
  unmappedCount: number;
} {
  const setActivities = resolveTodayTonalSets(input.tonalPayload, input.stateDate, input.timeZone);
  const mappedSets = setActivities.filter((set) => set.mapped && set.muscleGroup !== "unmapped" && set.raw.warmUp !== true);
  const grouped = new Map<string, TonalSetActivity[]>();

  for (const set of mappedSets) {
    const key = set.muscleGroup;
    grouped.set(key, [...(grouped.get(key) ?? []), set]);
  }

  const rows = Array.from(grouped.entries())
    .map(([muscleGroup, sets]) => {
      const workoutIds = new Set(sets.map((set) => set.workoutId).filter((value): value is string => Boolean(value)));
      return {
        stateDate: input.stateDate,
        muscleGroup,
        directSets: Number(sets.length.toFixed(2)),
        indirectSets: 0,
        hardSets: Number(sets.length.toFixed(2)),
        sessions: workoutIds.size,
        loadBucketSummary: loadBucketSummary(sets),
        repBucketSummary: repBucketSummary(sets),
        rirEstimateAvg: average(sets.map((set) => toNumber(set.raw.repsInReserve)), 2),
        sourceConfidence: average(sets.map((set) => set.confidence), 3),
        notes: {
          mapped_sets: sets.length,
          low_confidence_sets: boolFlagCount(sets, (set) => set.confidence < 0.7),
        },
      } satisfies MuscleVolumeDailyInput;
    })
    .sort((left, right) => left.muscleGroup.localeCompare(right.muscleGroup));

  const unmappedCount = boolFlagCount(setActivities, (set) => !set.mapped || set.muscleGroup === "unmapped");
  return { rows, setActivities, unmappedCount };
}

export function buildAthleteStateForDate(input: AthleteStateBuildInput): AthleteStateBuildResult {
  const timeZone = input.timeZone ?? "America/New_York";
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const recoveries = extractRecoveryEntries(input.whoopPayload, timeZone);
  const sleeps = extractSleepEntries(input.whoopPayload, timeZone);
  const whoopWorkouts = extractWhoopWorkouts(input.whoopPayload, timeZone);
  const todayRecovery = recoveries.find((entry) => entry.date === input.stateDate) ?? null;
  const todaySleep = sleeps.find((entry) => entry.date === input.stateDate) ?? null;
  const todayWhoopWorkouts = whoopWorkouts.filter((entry) => entry.date === input.stateDate);
  const yesterdayWhoopWorkouts = whoopWorkouts.filter((entry) => entry.date === daysBefore(input.stateDate, 1));
  const todayWhoopWorkoutStrain = roundSum(todayWhoopWorkouts.map((entry) => entry.strain)) ?? 0;
  const yesterdayWhoopWorkoutStrain = roundSum(yesterdayWhoopWorkouts.map((entry) => entry.strain)) ?? 0;
  const readinessSignal = buildReadinessSignal({
    recoveryTrend: computeTrend(recoveries.map((entry) => entry.recoveryScore)),
    hrvTrend: computeTrend(recoveries.map((entry) => entry.hrv)),
    rhrTrend: computeTrend(recoveries.map((entry) => entry.rhr)),
    sleepPerformance: todaySleep?.sleepPerformance ?? null,
    freshnessHours: dataFreshnessHours(todayRecovery?.createdAt ?? null),
    totalStrainToday: todayWhoopWorkoutStrain,
    yesterdayStrain: yesterdayWhoopWorkoutStrain,
  });
  const stepSummary = extractDailyStepCount(input.whoopPayload, input.stateDate, timeZone);
  const todayTonalWorkouts = tonalTodayWorkouts(input.tonalPayload, input.stateDate, timeZone);
  const muscleVolume = buildMuscleVolumeRowsForDate({
    stateDate: input.stateDate,
    tonalPayload: input.tonalPayload,
    timeZone,
  });
  const mealRollup = summarizeMealRollup(input.mealEntries, input.stateDate);
  const whoopQuality = readWhoopQuality(input.whoopPayload);
  const cardio = cardioDurationMinutes(input.whoopPayload, input.stateDate, timeZone);
  const phaseMode = normalizePhaseMode(input.phaseMode, input.coachNutrition);
  const nutritionConfidence = deriveNutritionConfidence(mealRollup.today.mealsLogged, input.coachNutrition);
  const proteinTargetG = inferProteinTargetG(phaseMode, input.coachNutrition);
  const healthRows = input.healthSourceRows ?? [];
  const fallbackBodyWeightKg = input.bodyWeightKg ?? extractBodyWeightKg(input.whoopPayload);
  const bodyWeightSelection = selectPreferredMetricForDate({
    metricName: "body_weight_kg",
    metricDate: input.stateDate,
    healthRows,
    fallbackValue: fallbackBodyWeightKg,
    fallbackSource: fallbackBodyWeightKg != null ? "whoop" : null,
    fallbackConfidence: fallbackBodyWeightKg != null ? 0.58 : null,
    fallbackUnit: "kg",
  });
  const stepSelection = selectPreferredMetricForDate({
    metricName: "steps",
    metricDate: input.stateDate,
    healthRows,
    fallbackValue: stepSummary.stepCount,
    fallbackSource: stepSummary.source,
    fallbackConfidence: stepSummary.stepCount != null ? 0.7 : null,
    fallbackUnit: "count",
  });
  const activeEnergySelection = selectPreferredMetricForDate({
    metricName: "active_energy_kcal",
    metricDate: input.stateDate,
    healthRows,
  });
  const restingEnergySelection = selectPreferredMetricForDate({
    metricName: "resting_energy_kcal",
    metricDate: input.stateDate,
    healthRows,
  });
  const distanceSelection = selectPreferredMetricForDate({
    metricName: "walking_running_distance_km",
    metricDate: input.stateDate,
    healthRows,
  });
  const bodyFatSelection = selectPreferredMetricForDate({
    metricName: "body_fat_pct",
    metricDate: input.stateDate,
    healthRows,
  });
  const leanMassSelection = selectPreferredMetricForDate({
    metricName: "lean_mass_kg",
    metricDate: input.stateDate,
    healthRows,
  });
  const bodyWeightTrend = buildWeeklyBodyWeightTrend({
    endDate: input.stateDate,
    healthRows,
  });
  const goalModeAssessment = assessGoalModeProgress({
    phaseMode,
    actualWeightDeltaPctWeek: bodyWeightTrend.deltaPct,
    confidence: bodyWeightTrend.confidence,
  });
  const healthSourceConfidence = selectionConfidence([
    bodyWeightSelection.confidence,
    stepSelection.usedFallback ? null : stepSelection.confidence,
    activeEnergySelection.confidence,
    restingEnergySelection.confidence,
    distanceSelection.confidence,
    bodyFatSelection.confidence,
    leanMassSelection.confidence,
  ]);
  const bodyWeightKg = bodyWeightSelection.value;
  const selectedHealthFlags = new Set([
    ...bodyWeightSelection.qualityFlags,
    ...stepSelection.qualityFlags,
    ...activeEnergySelection.qualityFlags,
    ...restingEnergySelection.qualityFlags,
    ...distanceSelection.qualityFlags,
    ...bodyFatSelection.qualityFlags,
    ...leanMassSelection.qualityFlags,
    ...bodyWeightTrend.qualityFlags,
  ]);
  const qualityFlags: Record<string, unknown> = {
    stale_provider_data:
      (dataFreshnessHours(todayRecovery?.createdAt ?? null) ?? 999) > 18
      || (dataFreshnessHours(todaySleep?.createdAt ?? null) ?? 999) > 18,
    unmapped_tonal_movements: muscleVolume.unmappedCount,
    duplicate_whoop_workouts_removed: toNumber(whoopQuality.duplicate_workout_ids_removed) ?? 0,
    repeated_whoop_next_token_detected: Boolean(whoopQuality.repeated_next_token_detected),
    missing_phase_mode: phaseMode === "unknown",
    missing_body_weight: bodyWeightKg == null,
    missing_nutrition_signal: mealRollup.today.mealsLogged === 0 && input.coachNutrition == null,
    apple_health_rows_present: healthRows.length > 0,
    body_weight_used_fallback: bodyWeightSelection.usedFallback,
    low_confidence_body_weight: bodyWeightSelection.value != null && (bodyWeightSelection.confidence ?? 0) < 0.55,
    health_quality_flags: [...selectedHealthFlags],
  };

  const athleteState: AthleteStateDailyInput = {
    stateDate: input.stateDate,
    generatedAt,
    readinessScore: todayRecovery?.recoveryScore ?? null,
    readinessBand: readinessSignal.band,
    readinessConfidence: readinessSignal.confidence,
    sleepHours: todaySleep?.sleepHours ?? null,
    sleepPerformance: todaySleep?.sleepPerformance ?? null,
    hrv: todayRecovery?.hrv ?? null,
    rhr: todayRecovery?.rhr ?? null,
    whoopStrain: todayWhoopWorkoutStrain,
    whoopWorkouts: todayWhoopWorkouts.length,
    stepCount: stepSelection.value,
    stepSource: stepSelection.source,
    tonalSessions: todayTonalWorkouts.length,
    tonalVolume: roundSum(todayTonalWorkouts.map((workout) => workout.volume)) ?? 0,
    cardioMinutes: cardio.totalMinutes,
    cardioSummary: cardio.summary,
    bodyWeightKg,
    bodyWeightSource: bodyWeightSelection.source,
    bodyWeightConfidence: bodyWeightSelection.confidence,
    activeEnergyKcal: activeEnergySelection.value,
    restingEnergyKcal: restingEnergySelection.value,
    walkingRunningDistanceKm: distanceSelection.value,
    bodyFatPct: bodyFatSelection.value,
    leanMassKg: leanMassSelection.value,
    healthSourceConfidence,
    healthContext: {
      body_weight: bodyWeightSelection,
      steps: stepSelection,
      active_energy: activeEnergySelection,
      resting_energy: restingEnergySelection,
      walking_running_distance: distanceSelection,
      body_fat: bodyFatSelection,
      lean_mass: leanMassSelection,
      weekly_body_weight_trend: bodyWeightTrend,
      goal_mode: goalModeAssessment,
      available_health_rows: healthRows.length,
    },
    phaseMode,
    targetWeightDeltaPctWeek: goalModeAssessment.targetWeightDeltaPctWeek ?? inferWeightDeltaTarget(phaseMode),
    proteinG: input.coachNutrition?.protein_actual_g ?? mealRollup.today.proteinG,
    proteinTargetG,
    caloriesKcal: input.coachNutrition?.calories_actual_kcal ?? mealRollup.today.calories,
    carbsG: input.coachNutrition?.carbs_g ?? mealRollup.today.carbsG,
    fatG: input.coachNutrition?.fats_g ?? mealRollup.today.fatG,
    hydrationLiters: input.coachNutrition?.hydration_liters ?? mealRollup.today.hydrationLiters,
    nutritionConfidence,
    recommendationMode: null,
    recommendationConfidence: null,
    qualityFlags,
    sourceRefs: {
      whoop_quality: whoopQuality,
      meals_logged_today: mealRollup.today.mealsLogged,
      tonal_set_rows: muscleVolume.setActivities.length,
      tonal_workouts_today: todayTonalWorkouts.length,
      coach_nutrition_row: input.coachNutrition?.date_local ?? null,
      body_weight_source: bodyWeightSelection.source,
      step_source_selected: stepSelection.source,
      apple_health_rows_considered: healthRows.length,
    },
    raw: {
      readiness_signal: readinessSignal,
      meal_rollup: mealRollup.today,
      body_weight_trend: bodyWeightTrend,
      goal_mode_assessment: goalModeAssessment,
    },
  };

  const fatigueContribution = buildFatigueDailyContribution({
    state_date: athleteState.stateDate,
    generated_at: athleteState.generatedAt ?? generatedAt,
    readiness_score: athleteState.readinessScore ?? null,
    readiness_band: athleteState.readinessBand ?? null,
    readiness_confidence: athleteState.readinessConfidence ?? null,
    sleep_hours: athleteState.sleepHours ?? null,
    sleep_performance: athleteState.sleepPerformance ?? null,
    hrv: athleteState.hrv ?? null,
    rhr: athleteState.rhr ?? null,
    whoop_strain: athleteState.whoopStrain ?? null,
    whoop_workouts: athleteState.whoopWorkouts ?? null,
    step_count: athleteState.stepCount ?? null,
    step_source: athleteState.stepSource ?? null,
    tonal_sessions: athleteState.tonalSessions ?? null,
    tonal_volume: athleteState.tonalVolume ?? null,
    cardio_minutes: athleteState.cardioMinutes ?? null,
    cardio_summary: athleteState.cardioSummary ?? {},
    body_weight_kg: athleteState.bodyWeightKg ?? null,
    body_weight_source: athleteState.bodyWeightSource ?? null,
    body_weight_confidence: athleteState.bodyWeightConfidence ?? null,
    active_energy_kcal: athleteState.activeEnergyKcal ?? null,
    resting_energy_kcal: athleteState.restingEnergyKcal ?? null,
    walking_running_distance_km: athleteState.walkingRunningDistanceKm ?? null,
    body_fat_pct: athleteState.bodyFatPct ?? null,
    lean_mass_kg: athleteState.leanMassKg ?? null,
    health_source_confidence: athleteState.healthSourceConfidence ?? null,
    health_context: athleteState.healthContext ?? {},
    phase_mode: athleteState.phaseMode ?? null,
    target_weight_delta_pct_week: athleteState.targetWeightDeltaPctWeek ?? null,
    fatigue_debt: null,
    sleep_debt: null,
    progression_momentum: null,
    training_context: {},
    protein_g: athleteState.proteinG ?? null,
    protein_target_g: athleteState.proteinTargetG ?? null,
    calories_kcal: athleteState.caloriesKcal ?? null,
    carbs_g: athleteState.carbsG ?? null,
    fat_g: athleteState.fatG ?? null,
    hydration_liters: athleteState.hydrationLiters ?? null,
    nutrition_confidence: athleteState.nutritionConfidence ?? null,
    recommendation_mode: athleteState.recommendationMode ?? null,
    recommendation_confidence: athleteState.recommendationConfidence ?? null,
    quality_flags: athleteState.qualityFlags ?? {},
    source_refs: athleteState.sourceRefs ?? {},
    raw: athleteState.raw ?? {},
  });

  athleteState.sleepDebt = fatigueContribution.sleep_debt;
  athleteState.fatigueDebt = fatigueContribution.fatigue_debt;
  athleteState.progressionMomentum = buildDailyProgressionMomentum({
    tonalVolume: athleteState.tonalVolume ?? null,
    tonalSessions: athleteState.tonalSessions ?? null,
    readinessScore: athleteState.readinessScore ?? null,
    sleepPerformance: athleteState.sleepPerformance ?? null,
    fatigueDebt: fatigueContribution.fatigue_debt,
  });
  athleteState.trainingContext = {
    cardio_modes: athleteState.cardioSummary?.by_mode_minutes ?? {},
    fatigue_contribution: fatigueContribution,
    goal_mode: goalModeAssessment.status,
    recommendation_ready: athleteState.readinessBand ?? "unknown",
  };

  return {
    athleteState,
    muscleVolumeRows: muscleVolume.rows,
    readinessSignal,
    todayWhoopWorkoutStrain,
    yesterdayWhoopWorkoutStrain,
  };
}
