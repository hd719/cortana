import type { AthleteStateDailyRow } from "./athlete-state-db.js";

export type FatigueEngineConfig = {
  lookbackDays: number;
  highDailyFatigueDebt: number;
  deloadFatigueDebt: number;
  deloadSleepDebt: number;
  deloadConsecutiveHighDays: number;
  lowSleepHours: number;
  lowSleepPerformance: number;
};

export type FatigueDailyContribution = {
  state_date: string;
  fatigue_debt: number;
  sleep_debt: number;
  readiness_penalty: number;
  strain_load: number;
  training_load: number;
  recovery_credit: number;
  confidence: number;
};

export type FatigueWindowSignal = {
  lookback_days: number;
  days: number;
  start_date: string | null;
  end_date: string | null;
  fatigue_debt: number;
  sleep_debt: number;
  average_daily_fatigue_debt: number;
  average_daily_sleep_debt: number;
  peak_daily_fatigue_debt: number;
  consecutive_high_fatigue_days: number;
  confidence: number;
  rationale: string[];
  daily: FatigueDailyContribution[];
};

export type DeloadTrigger = {
  triggered: boolean;
  recommendation: "progress" | "hold" | "deload";
  confidence: number;
  rationale: string;
  evidence: {
    fatigue_debt: number;
    sleep_debt: number;
    consecutive_high_fatigue_days: number;
    high_daily_fatigue_days: number;
    coverage_days: number;
  };
};

export const DEFAULT_FATIGUE_ENGINE_CONFIG: FatigueEngineConfig = {
  lookbackDays: 7,
  highDailyFatigueDebt: 8,
  deloadFatigueDebt: 24,
  deloadSleepDebt: 5,
  deloadConsecutiveHighDays: 3,
  lowSleepHours: 7,
  lowSleepPerformance: 80,
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

function pctDistance(value: number, target: number): number {
  return Math.max(0, target - value);
}

function sortRows(rows: AthleteStateDailyRow[]): AthleteStateDailyRow[] {
  return [...rows].sort((a, b) => a.state_date.localeCompare(b.state_date));
}

function tailRows(rows: AthleteStateDailyRow[], lookbackDays: number): AthleteStateDailyRow[] {
  if (lookbackDays <= 0) return [];
  return sortRows(rows).slice(Math.max(0, rows.length - lookbackDays));
}

function dailyConfidence(row: AthleteStateDailyRow): number {
  const checks = [
    row.readiness_score != null,
    row.sleep_hours != null,
    row.sleep_performance != null,
    row.whoop_strain != null,
    row.tonal_volume != null,
    row.tonal_sessions != null,
    row.cardio_minutes != null,
  ];
  const coverage = checks.filter(Boolean).length / checks.length;
  return round(clamp(0.4 + coverage * 0.6, 0.4, 0.98), 3);
}

export function buildFatigueDailyContribution(row: AthleteStateDailyRow): FatigueDailyContribution {
  const readinessPenalty = row.readiness_score == null ? 0.8 : round(pctDistance(row.readiness_score, 72) / 12);
  const strainLoad = round((row.whoop_strain ?? 0) * 0.85);
  const trainingLoad = round(((row.tonal_volume ?? 0) / 5000) + ((row.tonal_sessions ?? 0) * 0.75) + ((row.cardio_minutes ?? 0) / 30));
  const sleepDebt = buildSleepDebtForRow(row);
  const recoveryCredit = round((row.sleep_performance == null ? 0 : Math.max(0, row.sleep_performance - 80) / 20) + (row.sleep_hours == null ? 0 : Math.max(0, row.sleep_hours - 7.5)));
  const fatigueDebt = round(Math.max(0, readinessPenalty + strainLoad + trainingLoad + sleepDebt * 0.6 - recoveryCredit));

  return {
    state_date: row.state_date,
    fatigue_debt: fatigueDebt,
    sleep_debt: sleepDebt,
    readiness_penalty: round(readinessPenalty),
    strain_load: strainLoad,
    training_load: trainingLoad,
    recovery_credit: recoveryCredit,
    confidence: dailyConfidence(row),
  };
}

export function buildSleepDebtForRow(row: Pick<AthleteStateDailyRow, "sleep_hours" | "sleep_performance">): number {
  const sleepHoursDebt = row.sleep_hours == null ? 0 : pctDistance(row.sleep_hours, 7.5) * 1.6;
  const sleepPerformanceDebt = row.sleep_performance == null ? 0 : pctDistance(row.sleep_performance, 82) / 8;
  return round(Math.max(0, sleepHoursDebt + sleepPerformanceDebt));
}

export function buildRollingFatigueDebt(
  rows: AthleteStateDailyRow[],
  config: Partial<FatigueEngineConfig> = {},
): FatigueWindowSignal {
  const resolved = { ...DEFAULT_FATIGUE_ENGINE_CONFIG, ...config };
  const windowRows = tailRows(rows, resolved.lookbackDays);
  const daily = windowRows.map((row) => buildFatigueDailyContribution(row));
  const fatigueDebt = sum(daily.map((entry) => entry.fatigue_debt));
  const sleepDebt = sum(daily.map((entry) => entry.sleep_debt));
  const peakDailyFatigueDebt = daily.length ? Math.max(...daily.map((entry) => entry.fatigue_debt)) : 0;
  const consecutiveHighFatigueDays = daily.reduce((count, entry) => (entry.fatigue_debt >= resolved.highDailyFatigueDebt ? count + 1 : 0), 0);
  const confidence = round(clamp(avg(daily.map((entry) => entry.confidence)) ?? 0, 0, 0.98), 3);

  const rationale: string[] = [];
  if (fatigueDebt >= resolved.deloadFatigueDebt) rationale.push("Rolling fatigue debt is above the deload threshold.");
  if (sleepDebt >= resolved.deloadSleepDebt) rationale.push("Rolling sleep debt is above the sleep-risk threshold.");
  if (consecutiveHighFatigueDays >= resolved.deloadConsecutiveHighDays) rationale.push("High fatigue has persisted for multiple days.");
  if (!rationale.length) rationale.push("Rolling fatigue remains within the controllable range.");

  return {
    lookback_days: resolved.lookbackDays,
    days: windowRows.length,
    start_date: windowRows[0]?.state_date ?? null,
    end_date: windowRows[windowRows.length - 1]?.state_date ?? null,
    fatigue_debt: fatigueDebt,
    sleep_debt: sleepDebt,
    average_daily_fatigue_debt: windowRows.length ? round(fatigueDebt / windowRows.length) : 0,
    average_daily_sleep_debt: windowRows.length ? round(sleepDebt / windowRows.length) : 0,
    peak_daily_fatigue_debt: peakDailyFatigueDebt,
    consecutive_high_fatigue_days: consecutiveHighFatigueDays,
    confidence,
    rationale,
    daily,
  };
}

export function buildFatigueWindowSignal(
  rows: AthleteStateDailyRow[],
  config: Partial<FatigueEngineConfig> = {},
): FatigueWindowSignal {
  return buildRollingFatigueDebt(rows, config);
}

export function buildRollingSleepDebt(
  rows: AthleteStateDailyRow[],
  config: Partial<FatigueEngineConfig> = {},
): FatigueWindowSignal {
  return buildRollingFatigueDebt(rows, config);
}

export function buildDeloadTrigger(
  rows: AthleteStateDailyRow[],
  config: Partial<FatigueEngineConfig> = {},
): DeloadTrigger {
  const resolved = { ...DEFAULT_FATIGUE_ENGINE_CONFIG, ...config };
  const window = buildRollingFatigueDebt(rows, resolved);
  const highDailyFatigueDays = window.daily.filter((entry) => entry.fatigue_debt >= resolved.highDailyFatigueDebt).length;
  const triggered =
    window.fatigue_debt >= resolved.deloadFatigueDebt ||
    window.sleep_debt >= resolved.deloadSleepDebt ||
    window.consecutive_high_fatigue_days >= resolved.deloadConsecutiveHighDays;
  const recommendation = triggered ? "deload" : window.fatigue_debt >= resolved.highDailyFatigueDebt ? "hold" : "progress";
  const confidence = round(clamp(window.confidence + (triggered ? 0.08 : 0), 0.3, 0.98), 3);

  const rationaleParts: string[] = [];
  if (window.fatigue_debt >= resolved.deloadFatigueDebt) rationaleParts.push("fatigue debt is elevated");
  if (window.sleep_debt >= resolved.deloadSleepDebt) rationaleParts.push("sleep debt is elevated");
  if (window.consecutive_high_fatigue_days >= resolved.deloadConsecutiveHighDays) rationaleParts.push("fatigue has stayed high for multiple days");
  if (!rationaleParts.length) rationaleParts.push("fatigue and sleep are still in a workable range");

  return {
    triggered,
    recommendation,
    confidence,
    rationale: triggered
      ? `Deload triggered because ${rationaleParts.join(", ")}.`
      : `Deload not triggered because ${rationaleParts.join(", ")}.`,
    evidence: {
      fatigue_debt: window.fatigue_debt,
      sleep_debt: window.sleep_debt,
      consecutive_high_fatigue_days: window.consecutive_high_fatigue_days,
      high_daily_fatigue_days: highDailyFatigueDays,
      coverage_days: window.days,
    },
  };
}
