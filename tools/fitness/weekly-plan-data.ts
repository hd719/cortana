#!/usr/bin/env npx tsx

import { fetchAthleteStateRows, fetchMuscleVolumeRows, type AthleteStateDailyRow, type MuscleVolumeDailyRow } from "./athlete-state-db.js";
import { buildDeloadTrigger, buildFatigueWindowSignal } from "./fatigue-engine.js";
import { buildProgressionState } from "./progression-engine.js";
import {
  fetchRecommendationLogs,
  fetchTrainingStateWeekly,
  upsertRecommendationLog,
  upsertTrainingStateWeekly,
  type RecommendationLogInput,
  type TrainingStateWeeklyInput,
  type TrainingStateWeeklyRow,
} from "./training-intelligence-db.js";
import { buildCardioInterferenceAssessment } from "./training-engine.js";
import { buildWeeklyMuscleDoseAssessments } from "./volume-engine.js";
import { localYmd } from "./signal-utils.js";

export type WeeklyPlanBuildResult = {
  isoWeek: string;
  weekStart: string;
  weekEnd: string;
  trainingState: TrainingStateWeeklyInput;
  recommendation: RecommendationLogInput;
};

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: Array<number | null>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!nums.length) return null;
  return round(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function sum(values: Array<number | null>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!nums.length) return null;
  return round(nums.reduce((total, value) => total + value, 0));
}

export function isoWeekForDate(dateYmd: string): string {
  const date = new Date(`${dateYmd}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function startOfIsoWeek(endDate: string): string {
  const date = new Date(`${endDate}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (day - 1));
  return date.toISOString().slice(0, 10);
}

function endOfIsoWeek(startDate: string): string {
  const date = new Date(`${startDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 6);
  return date.toISOString().slice(0, 10);
}

function resolvePhaseMode(rows: AthleteStateDailyRow[]): string {
  const ranked = rows
    .map((row) => row.phase_mode)
    .filter((value): value is string => typeof value === "string" && value.length > 0 && value !== "unknown");
  return ranked[ranked.length - 1] ?? "unknown";
}

function mappedTrainingDays(rows: MuscleVolumeDailyRow[]): number {
  return new Set(rows.filter((row) => (row.hard_sets ?? 0) > 0).map((row) => row.state_date)).size;
}

function countProteinDays(rows: AthleteStateDailyRow[]): number {
  return rows.filter((row) => row.protein_g != null).length;
}

function buildDoseBuckets(assessments: ReturnType<typeof buildWeeklyMuscleDoseAssessments>) {
  const under: Record<string, unknown> = {};
  const adequate: Record<string, unknown> = {};
  const over: Record<string, unknown> = {};
  for (const assessment of assessments) {
    const payload = {
      hard_sets: assessment.hardSets,
      target_min: assessment.targetBand?.minHardSets ?? null,
      target_max: assessment.targetBand?.maxHardSets ?? null,
      confidence: assessment.confidence,
      rationale: assessment.rationale,
      row_count: assessment.rowCount,
    };
    if (assessment.status === "underdosed") under[assessment.muscleGroup] = payload;
    else if (assessment.status === "adequate") adequate[assessment.muscleGroup] = payload;
    else if (assessment.status === "overdosed") over[assessment.muscleGroup] = payload;
  }
  return { under, adequate, over };
}

function buildQualityFlags(input: {
  athleteStateRows: AthleteStateDailyRow[];
  doseAssessments: ReturnType<typeof buildWeeklyMuscleDoseAssessments>;
  fatigueConfidence: number;
  progressionConfidence: number;
}): Record<string, unknown> {
  const qualityFlags: Record<string, unknown> = {
    athlete_state_days: input.athleteStateRows.length,
    sparse_athlete_state: input.athleteStateRows.length < 5,
    sparse_protein_signal: countProteinDays(input.athleteStateRows) < 4,
    unknown_muscle_groups: input.doseAssessments.filter((entry) => entry.status === "unknown").map((entry) => entry.muscleGroup),
    low_readiness_coverage: input.athleteStateRows.filter((row) => row.readiness_score != null).length < 4,
    low_sleep_coverage: input.athleteStateRows.filter((row) => row.sleep_hours != null).length < 4,
    fatigue_confidence_low: input.fatigueConfidence < 0.55,
    progression_confidence_low: input.progressionConfidence < 0.55,
  };
  return qualityFlags;
}

function buildWeeklyRecommendationSummary(input: {
  underdosed: Record<string, unknown>;
  overdosed: Record<string, unknown>;
  fatigueDebt: number;
  deloadTriggered: boolean;
  progressionMomentum: number;
  interferenceRiskScore: number;
}): { mode: string; rationale: string; focus: string[]; risks: string[] } {
  const underdosedMuscles = Object.keys(input.underdosed);
  const overdosedMuscles = Object.keys(input.overdosed);
  const risks: string[] = [];
  if (input.deloadTriggered) risks.push("fatigue_debt");
  if (input.interferenceRiskScore >= 45) risks.push("cardio_interference");
  if (overdosedMuscles.length > 0) risks.push("volume_excess");

  if (input.deloadTriggered) {
    return {
      mode: "deload",
      rationale: "Fatigue debt is high enough that next week should reduce load and protect recovery.",
      focus: overdosedMuscles,
      risks,
    };
  }

  if (overdosedMuscles.length > underdosedMuscles.length && input.progressionMomentum <= 5) {
    return {
      mode: "volume_fall",
      rationale: "Weekly dose is already skewed high relative to recovery, so next week should trim fatigue before adding more work.",
      focus: overdosedMuscles,
      risks,
    };
  }

  if (underdosedMuscles.length > 0 && input.progressionMomentum >= -5) {
    return {
      mode: "volume_rise",
      rationale: "Several muscle groups are still below target and recovery is not collapsing, so next week can add productive sets selectively.",
      focus: underdosedMuscles,
      risks,
    };
  }

  return {
    mode: "volume_hold",
    rationale: "Weekly dose and recovery are close enough to hold steady while preserving execution quality.",
    focus: [],
    risks,
  };
}

export function buildWeeklyPlan(input: {
  endDate: string;
  athleteStateRows: AthleteStateDailyRow[];
  muscleVolumeRows: MuscleVolumeDailyRow[];
}): WeeklyPlanBuildResult {
  const weekStart = startOfIsoWeek(input.endDate);
  const weekEnd = endOfIsoWeek(weekStart);
  const isoWeek = isoWeekForDate(input.endDate);
  const phaseMode = resolvePhaseMode(input.athleteStateRows);
  const doseAssessments = buildWeeklyMuscleDoseAssessments({
    phaseMode: phaseMode === "maintenance" || phaseMode === "lean_gain" || phaseMode === "gentle_cut" || phaseMode === "aggressive_cut"
      ? phaseMode
      : "unknown",
    rows: input.muscleVolumeRows,
    includeUnknownMuscleGroups: true,
  });
  const { under, adequate, over } = buildDoseBuckets(doseAssessments);
  const fatigueWindow = buildFatigueWindowSignal(input.athleteStateRows, { lookbackDays: 7 });
  const deload = buildDeloadTrigger(input.athleteStateRows, { lookbackDays: 7 });
  const progression = buildProgressionState({
    athleteStateRows: input.athleteStateRows,
    muscleVolumeRows: input.muscleVolumeRows,
    fatigueWindow,
  });
  const cardio = buildCardioInterferenceAssessment(input.athleteStateRows, input.muscleVolumeRows);
  const recommendationSummary = buildWeeklyRecommendationSummary({
    underdosed: under,
    overdosed: over,
    fatigueDebt: fatigueWindow.fatigue_debt,
    deloadTriggered: deload.triggered,
    progressionMomentum: progression.momentum.momentum,
    interferenceRiskScore: cardio.score,
  });

  const confidence = round(
    Math.max(
      0.2,
      Math.min(
        0.98,
        ((average(doseAssessments.map((entry) => entry.confidence)) ?? 0.4) * 0.35)
          + (fatigueWindow.confidence * 0.25)
          + (progression.momentum.confidence * 0.25)
          + ((input.athleteStateRows.length >= 5 ? 0.13 : 0.04)),
      ),
    ),
    3,
  );
  const qualityFlags = buildQualityFlags({
    athleteStateRows: input.athleteStateRows,
    doseAssessments,
    fatigueConfidence: fatigueWindow.confidence,
    progressionConfidence: progression.momentum.confidence,
  });

  const trainingState: TrainingStateWeeklyInput = {
    isoWeek,
    weekStart,
    weekEnd,
    phaseMode,
    athleteStateDays: input.athleteStateRows.length,
    mappedTrainingDays: mappedTrainingDays(input.muscleVolumeRows),
    readinessAvg: average(input.athleteStateRows.map((row) => row.readiness_score)),
    sleepHoursAvg: average(input.athleteStateRows.map((row) => row.sleep_hours)),
    strainTotal: sum(input.athleteStateRows.map((row) => row.whoop_strain)),
    tonalSessions: input.athleteStateRows.reduce((sum, row) => sum + (row.tonal_sessions ?? 0), 0),
    tonalVolume: sum(input.athleteStateRows.map((row) => row.tonal_volume)),
    fatigueScore: fatigueWindow.fatigue_debt,
    progressionScore: progression.momentum.momentum,
    interferenceRiskScore: cardio.score,
    confidence,
    underdosedMuscles: under,
    adequatelyDosedMuscles: adequate,
    overdosedMuscles: over,
    cardioContext: {
      dominant_mode: cardio.dominant_mode,
      cardio_minutes: cardio.cardio_minutes,
      lower_body_hard_sets: cardio.lower_body_hard_sets,
      score: cardio.score,
      rationale: cardio.rationale,
    },
    recommendationSummary: {
      ...recommendationSummary,
      plateau: progression.plateau,
      momentum: progression.momentum,
      deload_trigger: deload,
    },
    qualityFlags,
    raw: {
      dose_assessments: doseAssessments,
      fatigue_window: fatigueWindow,
      progression_state: progression,
      cardio_assessment: cardio,
    },
  };

  const recommendation: RecommendationLogInput = {
    recommendationKey: `spartan:weekly:${isoWeek}`,
    recommendationScope: "weekly",
    isoWeek,
    mode: recommendationSummary.mode,
    confidence,
    rationale: recommendationSummary.rationale,
    inputs: {
      phase_mode: phaseMode,
      fatigue_score: fatigueWindow.fatigue_debt,
      progression_score: progression.momentum.momentum,
      interference_risk_score: cardio.score,
      underdosed_count: Object.keys(under).length,
      overdosed_count: Object.keys(over).length,
      quality_flags: qualityFlags,
    },
    outputs: trainingState.recommendationSummary ?? {},
  };

  return { isoWeek, weekStart, weekEnd, trainingState, recommendation };
}

export function persistWeeklyPlan(result: WeeklyPlanBuildResult): {
  trainingStateWrite: { ok: boolean; error?: string };
  recommendationWrite: { ok: boolean; error?: string };
} {
  return {
    trainingStateWrite: upsertTrainingStateWeekly(result.trainingState),
    recommendationWrite: upsertRecommendationLog(result.recommendation),
  };
}

export function buildAndPersistWeeklyPlan(input: {
  endDate: string;
  athleteStateRows: AthleteStateDailyRow[];
  muscleVolumeRows: MuscleVolumeDailyRow[];
}): WeeklyPlanBuildResult & {
  trainingStateWrite: { ok: boolean; error?: string };
  recommendationWrite: { ok: boolean; error?: string };
} {
  const result = buildWeeklyPlan(input);
  const writes = persistWeeklyPlan(result);
  return { ...result, ...writes };
}

function main(): void {
  const endDate = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : localYmd();
  const weekStart = startOfIsoWeek(endDate);
  const weekEnd = endOfIsoWeek(weekStart);
  const athleteStateRows = fetchAthleteStateRows(weekStart, weekEnd);
  const muscleVolumeRows = fetchMuscleVolumeRows(weekStart, weekEnd);
  const result = buildAndPersistWeeklyPlan({
    endDate,
    athleteStateRows,
    muscleVolumeRows,
  });
  const currentState = fetchTrainingStateWeekly(result.isoWeek);
  const logs = fetchRecommendationLogs("weekly", result.isoWeek);
  process.stdout.write(`${JSON.stringify({
    generated_at: new Date().toISOString(),
    ...result,
    persisted_training_state: currentState,
    persisted_recommendations: logs,
  })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
