import type { AthleteStateDailyInput, AthleteStatePhaseMode, MuscleVolumeDailyInput } from "./athlete-state-db.js";
import type { CoachNutritionRow } from "./coach-db.js";
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

function boolFlagCount(flags: TonalSetActivity[], predicate: (value: TonalSetActivity) => boolean): number {
  return flags.reduce((count, value) => count + (predicate(value) ? 1 : 0), 0);
}

function readWhoopQuality(payload: unknown): JsonObject {
  return toObj(toObj(payload).quality);
}

function cardioDurationMinutes(payload: unknown, stateDate: string, timeZone = "America/New_York"): {
  totalMinutes: number | null;
  summary: JsonObject;
} {
  const cardioSports = ["run", "ride", "cycle", "bike", "walk", "hike", "row", "swim", "cardio", "conditioning"];
  const workouts = Array.isArray(toObj(payload).workouts) ? (toObj(payload).workouts as unknown[]) : [];
  const bySport = new Map<string, number>();
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
  }

  return {
    totalMinutes: matched > 0 ? Number(totalMinutes.toFixed(2)) : null,
    summary: {
      sessions: matched,
      by_sport_minutes: Object.fromEntries(bySport.entries()),
    },
  };
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
  const bodyWeightKg = input.bodyWeightKg ?? extractBodyWeightKg(input.whoopPayload);
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
    stepCount: stepSummary.stepCount,
    stepSource: stepSummary.source,
    tonalSessions: todayTonalWorkouts.length,
    tonalVolume: roundSum(todayTonalWorkouts.map((workout) => workout.volume)) ?? 0,
    cardioMinutes: cardio.totalMinutes,
    cardioSummary: cardio.summary,
    bodyWeightKg,
    phaseMode,
    targetWeightDeltaPctWeek: inferWeightDeltaTarget(phaseMode),
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
    },
    raw: {
      readiness_signal: readinessSignal,
      meal_rollup: mealRollup.today,
    },
  };

  return {
    athleteState,
    muscleVolumeRows: muscleVolume.rows,
    readinessSignal,
    todayWhoopWorkoutStrain,
    yesterdayWhoopWorkoutStrain,
  };
}
