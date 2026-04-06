import type { AthleteStateDailyRow, MuscleVolumeDailyRow } from "./athlete-state-db.js";
import type { FatigueWindowSignal } from "./fatigue-engine.js";
import { buildRollingFatigueDebt } from "./fatigue-engine.js";

export type ProgressionEngineConfig = {
  lookbackDays: number;
  plateauVolumeDeltaPct: number;
  plateauHardSetDeltaPct: number;
  strongMomentumScore: number;
  weakMomentumScore: number;
};

export type ProgressionMomentumSignal = {
  momentum: number;
  direction: "accelerating" | "positive" | "flat" | "stalled" | "regressing";
  confidence: number;
  rationale: string[];
  evidence: {
    current_tonal_volume: number | null;
    previous_tonal_volume: number | null;
    tonal_volume_delta_pct: number | null;
    current_hard_sets: number | null;
    previous_hard_sets: number | null;
    hard_sets_delta_pct: number | null;
    current_readiness: number | null;
    previous_readiness: number | null;
    current_sleep_performance: number | null;
    previous_sleep_performance: number | null;
    fatigue_debt: number;
    sleep_debt: number;
  };
};

export type PlateauSignal = {
  plateau: boolean;
  recommendation: "progress" | "hold" | "deload";
  confidence: number;
  rationale: string;
  evidence: ProgressionMomentumSignal["evidence"] & {
    stalled_output: boolean;
    recovery_drag: boolean;
  };
};

export type ProgressionState = {
  momentum: ProgressionMomentumSignal;
  plateau: PlateauSignal;
};

export const DEFAULT_PROGRESSION_ENGINE_CONFIG: ProgressionEngineConfig = {
  lookbackDays: 7,
  plateauVolumeDeltaPct: 3,
  plateauHardSetDeltaPct: 3,
  strongMomentumScore: 18,
  weakMomentumScore: -12,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function avg(values: Array<number | null>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!nums.length) return null;
  return round(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function sum(values: Array<number | null>): number {
  return round(
    values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .reduce((total, value) => total + value, 0),
  );
}

function pctChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return round(((current - previous) / previous) * 100);
}

function keepZero(value: number | null): number | null {
  return value == null ? null : value;
}

function sortRows<T extends { state_date: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.state_date.localeCompare(b.state_date));
}

function splitWindow<T extends { state_date: string }>(rows: T[], lookbackDays: number): { previous: T[]; current: T[] } {
  const sorted = sortRows(rows);
  const current = sorted.slice(Math.max(0, sorted.length - lookbackDays));
  const previous = sorted.slice(Math.max(0, sorted.length - lookbackDays * 2), Math.max(0, sorted.length - lookbackDays));
  return { current, previous };
}

function sumTonalVolume(rows: AthleteStateDailyRow[]): number {
  return sum(rows.map((row) => row.tonal_volume));
}

function averageReadiness(rows: AthleteStateDailyRow[]): number | null {
  return avg(rows.map((row) => row.readiness_score));
}

function averageSleepPerformance(rows: AthleteStateDailyRow[]): number | null {
  return avg(rows.map((row) => row.sleep_performance));
}

function sumHardSets(rows: MuscleVolumeDailyRow[]): number {
  return sum(rows.map((row) => row.hard_sets));
}

function coverageScore(rows: AthleteStateDailyRow[], muscleRows: MuscleVolumeDailyRow[]): number {
  const checks = [
    rows.some((row) => row.tonal_volume != null),
    rows.some((row) => row.readiness_score != null),
    rows.some((row) => row.sleep_performance != null),
    muscleRows.some((row) => row.hard_sets != null),
  ];
  return checks.filter(Boolean).length / checks.length;
}

export function buildProgressionMomentum(input: {
  athleteStateRows: AthleteStateDailyRow[];
  muscleVolumeRows: MuscleVolumeDailyRow[];
  fatigueWindow?: FatigueWindowSignal | null;
  config?: Partial<ProgressionEngineConfig>;
}): ProgressionMomentumSignal {
  const resolved = { ...DEFAULT_PROGRESSION_ENGINE_CONFIG, ...(input.config ?? {}) };
  const { current: currentStateRows, previous: previousStateRows } = splitWindow(input.athleteStateRows, resolved.lookbackDays);
  const { current: currentMuscleRows, previous: previousMuscleRows } = splitWindow(input.muscleVolumeRows, resolved.lookbackDays);

  const currentTonalVolume = sumTonalVolume(currentStateRows);
  const previousTonalVolume = sumTonalVolume(previousStateRows);
  const currentHardSets = sumHardSets(currentMuscleRows);
  const previousHardSets = sumHardSets(previousMuscleRows);
  const currentReadiness = averageReadiness(currentStateRows);
  const previousReadiness = averageReadiness(previousStateRows);
  const currentSleepPerformance = averageSleepPerformance(currentStateRows);
  const previousSleepPerformance = averageSleepPerformance(previousStateRows);
  const fatigueWindow = input.fatigueWindow ?? buildRollingFatigueDebt(input.athleteStateRows, { lookbackDays: resolved.lookbackDays });
  const fatigueDebt = fatigueWindow.fatigue_debt;
  const sleepDebt = fatigueWindow.sleep_debt;
  const fatigueDebtPerDay = fatigueDebt / Math.max(1, currentStateRows.length || resolved.lookbackDays);
  const sleepDebtPerDay = sleepDebt / Math.max(1, currentStateRows.length || resolved.lookbackDays);

  const tonalVolumeDeltaPct = pctChange(currentTonalVolume, previousTonalVolume);
  const hardSetsDeltaPct = pctChange(currentHardSets, previousHardSets);
  const readinessDelta = currentReadiness != null && previousReadiness != null ? round(currentReadiness - previousReadiness) : null;
  const sleepDelta =
    currentSleepPerformance != null && previousSleepPerformance != null ? round(currentSleepPerformance - previousSleepPerformance) : null;

  const momentumRaw =
    (tonalVolumeDeltaPct ?? 0) * 0.35 +
    (hardSetsDeltaPct ?? 0) * 0.15 +
    (readinessDelta ?? 0) * 1.2 +
    (sleepDelta ?? 0) * 0.8 -
    fatigueDebtPerDay * 1.6 -
    sleepDebtPerDay * 1.0;

  const momentum = round(clamp(momentumRaw, -100, 100));
  const direction =
    momentum >= resolved.strongMomentumScore ? "accelerating" :
    momentum >= 5 ? "positive" :
    momentum > resolved.weakMomentumScore ? "flat" :
    momentum > -25 ? "stalled" :
    "regressing";

  const confidence = round(
    clamp(
      0.35 +
        coverageScore(input.athleteStateRows, input.muscleVolumeRows) * 0.4 +
        (input.fatigueWindow ? 0.15 : 0.05) +
        (tonalVolumeDeltaPct != null ? 0.05 : 0) +
        (hardSetsDeltaPct != null ? 0.05 : 0),
      0.2,
      0.98,
    ),
    3,
  );

  const rationale: string[] = [];
  if (tonalVolumeDeltaPct != null) rationale.push(`Tonal volume changed by ${tonalVolumeDeltaPct}%.`);
  if (hardSetsDeltaPct != null) rationale.push(`Hard sets changed by ${hardSetsDeltaPct}%.`);
  if (readinessDelta != null) rationale.push(`Readiness changed by ${readinessDelta}.`);
  if (sleepDelta != null) rationale.push(`Sleep performance changed by ${sleepDelta}.`);
  if (fatigueDebt > 0 || sleepDebt > 0) rationale.push(`Fatigue debt is ${fatigueDebt} and sleep debt is ${sleepDebt}.`);
  if (!rationale.length) rationale.push("Insufficient signal to call progression direction confidently.");

  return {
    momentum,
    direction,
    confidence,
    rationale,
    evidence: {
      current_tonal_volume: keepZero(currentTonalVolume),
      previous_tonal_volume: keepZero(previousTonalVolume),
      tonal_volume_delta_pct: tonalVolumeDeltaPct,
      current_hard_sets: keepZero(currentHardSets),
      previous_hard_sets: keepZero(previousHardSets),
      hard_sets_delta_pct: hardSetsDeltaPct,
      current_readiness: keepZero(currentReadiness),
      previous_readiness: keepZero(previousReadiness),
      current_sleep_performance: keepZero(currentSleepPerformance),
      previous_sleep_performance: keepZero(previousSleepPerformance),
      fatigue_debt: fatigueDebt,
      sleep_debt: sleepDebt,
    },
  };
}

export function buildPlateauSignal(input: {
  athleteStateRows: AthleteStateDailyRow[];
  muscleVolumeRows: MuscleVolumeDailyRow[];
  fatigueWindow?: FatigueWindowSignal | null;
  config?: Partial<ProgressionEngineConfig>;
}): PlateauSignal {
  const resolved = { ...DEFAULT_PROGRESSION_ENGINE_CONFIG, ...(input.config ?? {}) };
  const momentum = buildProgressionMomentum(input);
  const stalledOutput =
    (momentum.evidence.tonal_volume_delta_pct != null && momentum.evidence.tonal_volume_delta_pct <= resolved.plateauVolumeDeltaPct) ||
    (momentum.evidence.hard_sets_delta_pct != null && momentum.evidence.hard_sets_delta_pct <= resolved.plateauHardSetDeltaPct);
  const recoveryDrag =
    (momentum.evidence.fatigue_debt / Math.max(1, input.athleteStateRows.length || resolved.lookbackDays) >= 4) ||
    (momentum.evidence.sleep_debt / Math.max(1, input.athleteStateRows.length || resolved.lookbackDays) >= 1) ||
    ((momentum.evidence.current_readiness ?? 0) <= (momentum.evidence.previous_readiness ?? 0) - 2) ||
    ((momentum.evidence.current_sleep_performance ?? 0) <= (momentum.evidence.previous_sleep_performance ?? 0) - 2);
  const plateau = stalledOutput && recoveryDrag && momentum.momentum <= 5;
  const recommendation = plateau
    ? ((momentum.evidence.fatigue_debt / Math.max(1, input.athleteStateRows.length || resolved.lookbackDays) >= 4) ||
      (momentum.evidence.sleep_debt / Math.max(1, input.athleteStateRows.length || resolved.lookbackDays) >= 1)
        ? "deload"
        : "hold")
    : momentum.momentum >= resolved.strongMomentumScore ? "progress" : "hold";
  const confidence = round(clamp(momentum.confidence + (plateau ? 0.04 : 0), 0.2, 0.98), 3);
  const rationale = plateau
    ? "Output has stalled while recovery is deteriorating, so progression should pause or deload."
    : "Training output and recovery still leave room to progress.";

  return {
    plateau,
    recommendation,
    confidence,
    rationale,
    evidence: {
      ...momentum.evidence,
      stalled_output: stalledOutput,
      recovery_drag: recoveryDrag,
    },
  };
}

export function buildProgressionState(input: {
  athleteStateRows: AthleteStateDailyRow[];
  muscleVolumeRows: MuscleVolumeDailyRow[];
  fatigueWindow?: FatigueWindowSignal | null;
  config?: Partial<ProgressionEngineConfig>;
}): ProgressionState {
  const momentum = buildProgressionMomentum(input);
  const plateau = buildPlateauSignal(input);
  return { momentum, plateau };
}
