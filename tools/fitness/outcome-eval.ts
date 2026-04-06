import type { ReadinessBand } from "./signal-utils.js";

export type OutcomePeriod = "weekly" | "monthly";

export type OutcomeEvaluationInput = {
  period: OutcomePeriod;
  isoLabel: string;
  periodStart: string;
  periodEnd: string;
  plannedTrainingDays: number;
  completedTrainingDays: number;
  missedTrainingDays?: number;
  recoveryDaysLogged: number;
  sleepDaysLogged: number;
  proteinDaysLogged: number;
  proteinDaysOnTarget: number;
  avgRecovery: number | null;
  avgSleepHours: number | null;
  avgProteinG: number | null;
  tonalSessions: number;
  tonalVolume: number | null;
  tonalVolumeDeltaPct: number | null;
  whoopStrainDeltaPct: number | null;
  painDays: number;
  scheduleConflicts: number;
  overreachAlerts: number;
  staleDataDays: number;
  performanceTrend: "improving" | "stable" | "regressing" | "unknown";
  readinessBand?: ReadinessBand;
};

export type OutcomeEvaluation = {
  period: OutcomePeriod;
  iso_label: string;
  period_start: string;
  period_end: string;
  overall_score: number;
  component_scores: {
    adherence: number;
    recovery_alignment: number;
    nutrition_alignment: number;
    risk_management: number;
    performance_alignment: number;
  };
  confidence: "high" | "medium" | "low";
  summary: string;
  wins: string[];
  misses: string[];
  caveats: string[];
  evidence: Record<string, unknown>;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value);
}

function ratioScore(numerator: number, denominator: number, maxScore: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return clamp((numerator / denominator) * maxScore, 0, maxScore);
}

function scoreAdherence(input: OutcomeEvaluationInput): number {
  const planned = Math.max(1, input.plannedTrainingDays);
  const completionScore = ratioScore(input.completedTrainingDays, planned, 75);
  const fuelCoverage = ratioScore(input.proteinDaysLogged, planned, 25);
  const missedPenalty = Math.min(20, (input.missedTrainingDays ?? Math.max(0, planned - input.completedTrainingDays)) * 4);
  return clamp(round(completionScore + fuelCoverage - missedPenalty), 0, 100);
}

function scoreRecoveryAlignment(input: OutcomeEvaluationInput): number {
  const recoveryScore = input.avgRecovery == null ? 28 : clamp((input.avgRecovery / 100) * 60, 0, 60);
  const sleepScore = input.avgSleepHours == null ? 20 : clamp((input.avgSleepHours / 8.5) * 40, 0, 40);
  const loadPenalty = clamp((input.overreachAlerts * 8) + (input.painDays * 5) + (input.scheduleConflicts * 3), 0, 30);
  return clamp(round(recoveryScore + sleepScore - loadPenalty), 0, 100);
}

function scoreNutritionAlignment(input: OutcomeEvaluationInput): number {
  const planned = Math.max(1, input.plannedTrainingDays);
  const coverageScore = ratioScore(input.proteinDaysLogged, planned, 45);
  const onTargetScore = input.proteinDaysLogged > 0 ? ratioScore(input.proteinDaysOnTarget, input.proteinDaysLogged, 35) : 0;
  let avgProteinScore = 20;
  if (input.avgProteinG == null) avgProteinScore = 10;
  else if (input.avgProteinG >= 112 && input.avgProteinG <= 140) avgProteinScore = 20;
  else if (input.avgProteinG < 112) avgProteinScore = 12;
  else if (input.avgProteinG > 140) avgProteinScore = 15;
  return clamp(round(coverageScore + onTargetScore + avgProteinScore), 0, 100);
}

function scoreRiskManagement(input: OutcomeEvaluationInput): number {
  const penalty =
    (input.painDays * 14) +
    (input.scheduleConflicts * 11) +
    (input.overreachAlerts * 12) +
    (input.staleDataDays * 6);
  return clamp(round(100 - penalty), 0, 100);
}

function scorePerformanceAlignment(input: OutcomeEvaluationInput): number {
  let trendScore = 12;
  if (input.performanceTrend === "improving") trendScore = 30;
  else if (input.performanceTrend === "stable") trendScore = 20;
  else if (input.performanceTrend === "regressing") trendScore = 6;

  const sessionsScore = clamp(input.tonalSessions * 8, 0, 24);
  const volumeScore = input.tonalVolumeDeltaPct == null
    ? 12
    : clamp(12 + (input.tonalVolumeDeltaPct * 0.8), 0, 32);
  const strainPenalty = input.whoopStrainDeltaPct != null && input.whoopStrainDeltaPct > 0 ? 6 : 0;
  return clamp(round(trendScore + sessionsScore + volumeScore - strainPenalty), 0, 100);
}

function confidenceFor(input: OutcomeEvaluationInput): "high" | "medium" | "low" {
  const coverage = input.recoveryDaysLogged + input.sleepDaysLogged + input.proteinDaysLogged;
  if (input.staleDataDays > 0 || coverage < 6) return "low";
  if (coverage < 15) return "medium";
  return "high";
}

function caveatsFor(input: OutcomeEvaluationInput): string[] {
  const caveats: string[] = [];
  if (input.recoveryDaysLogged < 3) caveats.push("Recovery coverage is sparse, so the recovery score is partially inferred.");
  if (input.sleepDaysLogged < 3) caveats.push("Sleep coverage is sparse, so sleep alignment is less certain.");
  if (input.proteinDaysLogged === 0) caveats.push("Protein adherence is unobserved, so nutrition scoring defaults conservative.");
  if (input.tonalSessions === 0) caveats.push("No Tonal sessions were logged, so performance alignment is limited.");
  if (input.performanceTrend === "unknown") caveats.push("Performance trend is unknown, so adaptation quality is judged mostly from consistency.");
  if (input.staleDataDays > 0) caveats.push("One or more days used stale data, so the overall score is discounted in confidence.");
  return caveats;
}

function summaryFor(score: number): string {
  if (score >= 80) return "strong alignment";
  if (score >= 65) return "mixed alignment";
  return "needs correction";
}

function winsFor(input: OutcomeEvaluationInput, components: OutcomeEvaluation["component_scores"]): string[] {
  const wins: string[] = [];
  if (components.adherence >= 75) wins.push("Training follow-through stayed strong.");
  if (components.recovery_alignment >= 70) wins.push("Recovery inputs supported training instead of fighting it.");
  if (components.nutrition_alignment >= 70) wins.push("Fueling was consistent enough to support adaptation.");
  if (components.performance_alignment >= 70) wins.push("Training output or trend direction moved in a favorable direction.");
  if (input.overreachAlerts === 0) wins.push("No major overreach signals were recorded.");
  return wins;
}

function missesFor(input: OutcomeEvaluationInput, components: OutcomeEvaluation["component_scores"]): string[] {
  const misses: string[] = [];
  if (components.adherence < 70) misses.push("Adherence lagged enough to limit the weekly outcome.");
  if (components.recovery_alignment < 70) misses.push("Recovery alignment was not strong enough to absorb all training stress cleanly.");
  if (components.nutrition_alignment < 70) misses.push("Nutrition coverage or protein execution was too uneven.");
  if (components.risk_management < 70) misses.push("Risk management was not tight enough for a fully controlled week.");
  if (components.performance_alignment < 70) misses.push("Performance output was not clearly improving.");
  if (input.painDays > 0) misses.push("Pain signals were present during the week.");
  return misses;
}

export function evaluateOutcomeWindow(input: OutcomeEvaluationInput): OutcomeEvaluation {
  const component_scores = {
    adherence: scoreAdherence(input),
    recovery_alignment: scoreRecoveryAlignment(input),
    nutrition_alignment: scoreNutritionAlignment(input),
    risk_management: scoreRiskManagement(input),
    performance_alignment: scorePerformanceAlignment(input),
  };

  const overall_score = clamp(
    round(
      (component_scores.adherence * 0.25) +
      (component_scores.recovery_alignment * 0.20) +
      (component_scores.nutrition_alignment * 0.20) +
      (component_scores.risk_management * 0.20) +
      (component_scores.performance_alignment * 0.15),
    ),
    0,
    100,
  );
  const caveats = caveatsFor(input);
  const confidence = confidenceFor(input);

  return {
    period: input.period,
    iso_label: input.isoLabel,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    overall_score,
    component_scores,
    confidence,
    summary: summaryFor(overall_score),
    wins: winsFor(input, component_scores),
    misses: missesFor(input, component_scores),
    caveats,
    evidence: {
      planned_training_days: input.plannedTrainingDays,
      completed_training_days: input.completedTrainingDays,
      missed_training_days: input.missedTrainingDays ?? Math.max(0, input.plannedTrainingDays - input.completedTrainingDays),
      recovery_days_logged: input.recoveryDaysLogged,
      sleep_days_logged: input.sleepDaysLogged,
      protein_days_logged: input.proteinDaysLogged,
      protein_days_on_target: input.proteinDaysOnTarget,
      avg_recovery: input.avgRecovery,
      avg_sleep_hours: input.avgSleepHours,
      avg_protein_g: input.avgProteinG,
      tonal_sessions: input.tonalSessions,
      tonal_volume: input.tonalVolume,
      tonal_volume_delta_pct: input.tonalVolumeDeltaPct,
      whoop_strain_delta_pct: input.whoopStrainDeltaPct,
      pain_days: input.painDays,
      schedule_conflicts: input.scheduleConflicts,
      overreach_alerts: input.overreachAlerts,
      stale_data_days: input.staleDataDays,
      performance_trend: input.performanceTrend,
      readiness_band: input.readinessBand ?? null,
    },
  };
}

export function evaluateWeeklyOutcome(input: Omit<OutcomeEvaluationInput, "period">): OutcomeEvaluation {
  return evaluateOutcomeWindow({ ...input, period: "weekly" });
}

export function evaluateMonthlyOutcome(input: Omit<OutcomeEvaluationInput, "period">): OutcomeEvaluation {
  return evaluateOutcomeWindow({ ...input, period: "monthly" });
}

