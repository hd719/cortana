#!/usr/bin/env npx tsx

import os from "node:os";
import path from "node:path";
import { chooseSurfacedInsightIds, fetchPendingHealthInsights, markInsightsSql } from "./insights-db.js";
import { fetchCoachCaffeineWindowSummary, upsertCoachWeeklyScore } from "./coach-db.js";
import { fetchAthleteStateRows, fetchMuscleVolumeRows, type AthleteStateDailyRow } from "./athlete-state-db.js";
import {
  fetchCoachAlertWindowSummary,
  fetchCoachCheckinWindowSummary,
  upsertCoachOutcomeEvalWeekly,
} from "./checkin-db.js";
import { evaluateWeeklyOutcome } from "./outcome-eval.js";
import { localYmd, type ReadinessBand } from "./signal-utils.js";
import { buildWeeklyDoseCalls, detectCardioInterference, detectCutRateRisk } from "./training-engine.js";
import { buildAndPersistWeeklyPlan } from "./weekly-plan-data.js";

type WindowMetrics = {
  days_with_recovery: number;
  avg_recovery: number | null;
  avg_hrv: number | null;
  avg_rhr: number | null;
  days_with_sleep: number;
  avg_sleep_hours: number | null;
  avg_sleep_performance: number | null;
  whoop_workouts: number;
  total_strain: number | null;
  avg_strain: number | null;
  tonal_sessions: number;
  tonal_total_volume: number | null;
  avg_tonal_volume: number | null;
  body_weight_days_logged: number;
  avg_body_weight_kg: number | null;
  avg_active_energy_kcal: number | null;
  avg_resting_energy_kcal: number | null;
  avg_walking_running_distance_km: number | null;
  meals_logged: number;
  protein_days_logged: number;
  protein_avg_daily: number | null;
  protein_days_on_target: number;
};

type MetricDelta = {
  current: number | null;
  previous: number | null;
  delta: number | null;
  delta_pct: number | null;
};

export type WeeklyProteinAssumption = {
  status: "observed_from_logs" | "assume_likely_below_target_unverified" | "assume_inconsistent_unverified";
  confidence: "high" | "medium" | "low";
  rationale: string;
  coaching_note: string;
};

function currentIsoWeekTag(date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function weeklyPaths(isoWeek: string, agentId = "cron-fitness"): {
  sandboxFilePath: string;
  repoFilePath: string;
} {
  return {
    sandboxFilePath: path.join(os.homedir(), ".openclaw", "workspaces", agentId, "memory", "fitness", "weekly", `${isoWeek}.md`),
    repoFilePath: path.join("/Users/hd/Developer/cortana/memory/fitness/weekly", `${isoWeek}.md`),
  };
}

function ymdDaysAgo(days: number): string {
  return localYmd("America/New_York", new Date(Date.now() - days * 24 * 3600 * 1000));
}

function inRange(dateYmd: string, startYmd: string, endYmd: string): boolean {
  return dateYmd >= startYmd && dateYmd <= endYmd;
}

function average(values: Array<number | null>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!nums.length) return null;
  return Number((nums.reduce((sum, value) => sum + value, 0) / nums.length).toFixed(2));
}

function sum(values: Array<number | null>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!nums.length) return null;
  return Number(nums.reduce((total, value) => total + value, 0).toFixed(2));
}

function compareMetric(current: number | null, previous: number | null): MetricDelta {
  const delta = current != null && previous != null ? Number((current - previous).toFixed(2)) : null;
  const deltaPct =
    current != null && previous != null && previous !== 0 ? Number((((current - previous) / previous) * 100).toFixed(2)) : null;
  return { current, previous, delta, delta_pct: deltaPct };
}

export function buildWeeklyWindowMetricsFromState(opts: {
  startYmd: string;
  endYmd: string;
  athleteStateRows: AthleteStateDailyRow[];
}): WindowMetrics {
  const rows = opts.athleteStateRows.filter((row) => inRange(row.state_date, opts.startYmd, opts.endYmd));
  const proteinTotals = rows.map((row) => row.protein_g);

  return {
    days_with_recovery: rows.filter((row) => row.readiness_score != null).length,
    avg_recovery: average(rows.map((row) => row.readiness_score)),
    avg_hrv: average(rows.map((row) => row.hrv)),
    avg_rhr: average(rows.map((row) => row.rhr)),
    days_with_sleep: rows.filter((row) => row.sleep_hours != null).length,
    avg_sleep_hours: average(rows.map((row) => row.sleep_hours)),
    avg_sleep_performance: average(rows.map((row) => row.sleep_performance)),
    whoop_workouts: rows.reduce((sum, row) => sum + (row.whoop_workouts ?? 0), 0),
    total_strain: sum(rows.map((row) => row.whoop_strain)),
    avg_strain: average(rows.map((row) => row.whoop_strain)),
    tonal_sessions: rows.reduce((sum, row) => sum + (row.tonal_sessions ?? 0), 0),
    tonal_total_volume: sum(rows.map((row) => row.tonal_volume)),
    avg_tonal_volume: average(rows.map((row) => row.tonal_volume)),
    body_weight_days_logged: rows.filter((row) => row.body_weight_kg != null).length,
    avg_body_weight_kg: average(rows.map((row) => row.body_weight_kg)),
    avg_active_energy_kcal: average(rows.map((row) => row.active_energy_kcal)),
    avg_resting_energy_kcal: average(rows.map((row) => row.resting_energy_kcal)),
    avg_walking_running_distance_km: average(rows.map((row) => row.walking_running_distance_km)),
    meals_logged: rows.reduce((sum, row) => sum + ((row.raw?.meal_rollup as { mealsLogged?: number } | undefined)?.mealsLogged ?? 0), 0),
    protein_days_logged: rows.filter((row) => row.protein_g != null).length,
    protein_avg_daily: average(proteinTotals),
    protein_days_on_target: rows.filter((row) => row.protein_g != null && row.protein_target_g != null && row.protein_g >= row.protein_target_g).length,
  };
}

function hardTruthRiskBand(trends: {
  recovery: MetricDelta;
  sleepHours: MetricDelta;
  strainLoad: MetricDelta;
}): ReadinessBand {
  const recoveryDown = (trends.recovery.delta ?? 0) <= -4;
  const sleepDown = (trends.sleepHours.delta ?? 0) <= -0.4;
  const strainUp = (trends.strainLoad.delta ?? 0) >= 8;
  if ((recoveryDown && strainUp) || (sleepDown && strainUp)) return "red";
  if (recoveryDown || sleepDown || strainUp) return "yellow";
  return "green";
}

export function buildWeeklyProteinAssumption(opts: {
  currentDaysLogged: number;
  previousDaysLogged: number;
  currentAvgProtein: number | null;
}): WeeklyProteinAssumption {
  if (opts.currentDaysLogged >= 5 && opts.currentAvgProtein != null) {
    return {
      status: "observed_from_logs",
      confidence: "high",
      rationale: "Protein trend is backed by sufficient meal-log coverage this week.",
      coaching_note: "Use logged trend directly for adherence coaching.",
    };
  }
  if (opts.currentDaysLogged === 0 && opts.previousDaysLogged === 0) {
    return {
      status: "assume_likely_below_target_unverified",
      confidence: "low",
      rationale: "No protein logs for two consecutive weeks; default to under-fueling risk.",
      coaching_note: "Assume adherence is below target until logs prove otherwise.",
    };
  }
  return {
    status: "assume_inconsistent_unverified",
    confidence: "low",
    rationale: "Sparse protein logs limit direct adherence confidence.",
    coaching_note: "Assume inconsistent adherence and prioritize consistent logging.",
  };
}

function performanceTrend(opts: {
  tonalSessions: number;
  tonalVolumeDeltaPct: number | null;
  recoveryDeltaPct: number | null;
}): "improving" | "stable" | "regressing" | "unknown" {
  if (opts.tonalSessions === 0) return "unknown";
  if ((opts.tonalVolumeDeltaPct ?? 0) >= 5 && (opts.recoveryDeltaPct ?? 0) >= -8) return "improving";
  if ((opts.tonalVolumeDeltaPct ?? 0) <= -10) return "regressing";
  return "stable";
}



function weeklyAge100Score(input: {
  avgSleepHours: number | null;
  avgRecovery: number | null;
  strainDelta: number | null;
  proteinDaysOnTarget: number;
  proteinDaysLogged: number;
  errors: string[];
  caffeineDailyAvgMg: number | null;
  caffeineLateDays: number;
}): { score: number; components: Record<string, number>; summary: string } {
  const sleepScore = input.avgSleepHours == null ? 12 : Math.max(0, Math.min(30, Math.round((input.avgSleepHours / 8) * 30)));
  const recoveryScore = input.avgRecovery == null ? 10 : Math.max(0, Math.min(25, Math.round((input.avgRecovery / 100) * 25)));
  const strainPenalty = input.strainDelta != null && input.strainDelta > 8 ? 12 : input.strainDelta != null && input.strainDelta > 3 ? 6 : 0;
  const loadScore = Math.max(0, 20 - strainPenalty);
  const proteinScoreBase = input.proteinDaysLogged === 0 ? 6 : Math.round((input.proteinDaysOnTarget / 7) * 25);
  const proteinScore = Math.max(0, Math.min(25, proteinScoreBase));
  const caffeinePenalty = input.caffeineDailyAvgMg == null ? 0 : input.caffeineDailyAvgMg > 350 ? 8 : input.caffeineDailyAvgMg > 250 ? 4 : 0;
  const latePenalty = input.caffeineLateDays >= 3 ? 6 : input.caffeineLateDays >= 1 ? 3 : 0;
  const dataPenalty = input.errors.length > 0 ? 5 : 0;
  const score = Math.max(0, Math.min(100, sleepScore + recoveryScore + loadScore + proteinScore - caffeinePenalty - latePenalty - dataPenalty));
  const summary = score >= 80 ? "strong alignment" : score >= 65 ? "moderate alignment" : "needs correction";
  return {
    score,
    components: { sleep: sleepScore, recovery: recoveryScore, load: loadScore, protein: proteinScore, caffeine_penalty: caffeinePenalty, late_caffeine_penalty: latePenalty, data_penalty: dataPenalty },
    summary,
  };
}

function main(): void {
  const errors: string[] = [];
  const today = localYmd();

  const currentStart = ymdDaysAgo(6);
  const currentEnd = today;
  const previousStart = ymdDaysAgo(13);
  const previousEnd = ymdDaysAgo(7);

  const currentRows = fetchAthleteStateRows(currentStart, currentEnd);
  const previousRows = fetchAthleteStateRows(previousStart, previousEnd);
  const currentMuscleRows = fetchMuscleVolumeRows(currentStart, currentEnd);
  const previousMuscleRows = fetchMuscleVolumeRows(previousStart, previousEnd);
  const currentMetrics = buildWeeklyWindowMetricsFromState({
    startYmd: currentStart,
    endYmd: currentEnd,
    athleteStateRows: currentRows,
  });
  const previousMetrics = buildWeeklyWindowMetricsFromState({
    startYmd: previousStart,
    endYmd: previousEnd,
    athleteStateRows: previousRows,
  });

  if (currentRows.length === 0) errors.push("athlete_state_missing");
  if (currentMetrics.days_with_recovery === 0) errors.push("whoop_recovery_missing");
  if (currentMetrics.days_with_sleep === 0) errors.push("whoop_sleep_missing");

  const trendSignals = {
    recovery: compareMetric(currentMetrics.avg_recovery, previousMetrics.avg_recovery),
    sleep_hours: compareMetric(currentMetrics.avg_sleep_hours, previousMetrics.avg_sleep_hours),
    sleep_performance: compareMetric(currentMetrics.avg_sleep_performance, previousMetrics.avg_sleep_performance),
    strain_load: compareMetric(currentMetrics.total_strain, previousMetrics.total_strain),
    tonal_volume: compareMetric(currentMetrics.tonal_total_volume, previousMetrics.tonal_total_volume),
    body_weight_kg: compareMetric(currentMetrics.avg_body_weight_kg, previousMetrics.avg_body_weight_kg),
    protein_avg_daily: compareMetric(currentMetrics.protein_avg_daily, previousMetrics.protein_avg_daily),
  };

  const riskBand = hardTruthRiskBand({
    recovery: trendSignals.recovery,
    sleepHours: trendSignals.sleep_hours,
    strainLoad: trendSignals.strain_load,
  });
  const proteinAssumption = buildWeeklyProteinAssumption({
    currentDaysLogged: currentMetrics.protein_days_logged,
    previousDaysLogged: previousMetrics.protein_days_logged,
    currentAvgProtein: currentMetrics.protein_avg_daily,
  });

  const caffeineCurrent = fetchCoachCaffeineWindowSummary(currentStart, currentEnd);
  const caffeinePrevious = fetchCoachCaffeineWindowSummary(previousStart, previousEnd);
  const checkinSummary = fetchCoachCheckinWindowSummary(currentStart, currentEnd);
  const alertSummary = fetchCoachAlertWindowSummary(currentStart, currentEnd);
  const phaseModeForWeek = currentRows
    .slice()
    .reverse()
    .find((row) => row.phase_mode && row.phase_mode !== "unknown")?.phase_mode ?? "unknown";
  const weeklyDoseCalls = buildWeeklyDoseCalls(currentMuscleRows, phaseModeForWeek);
  const cutRateRisk = detectCutRateRisk(currentRows);
  const cardioInterferenceRisk = detectCardioInterference(currentRows, currentMuscleRows);
  const weeklyPlan = buildAndPersistWeeklyPlan({
    endDate: currentEnd,
    athleteStateRows: currentRows,
    muscleVolumeRows: currentMuscleRows,
  });
  if (!weeklyPlan.trainingStateWrite.ok) errors.push(`training_state_weekly_upsert_failed:${weeklyPlan.trainingStateWrite.error ?? "unknown"}`);
  if (!weeklyPlan.recommendationWrite.ok) errors.push(`recommendation_log_upsert_failed:${weeklyPlan.recommendationWrite.error ?? "unknown"}`);

  const pendingInsights = fetchPendingHealthInsights(8);
  const surfacedInsightIds = chooseSurfacedInsightIds(pendingInsights, riskBand, 2);
  const isoWeek = currentIsoWeekTag();
  const weeklyTarget = weeklyPaths(isoWeek);
  const plannedTrainingDays = 5;
  const completedTrainingDays = Math.max(
    checkinSummary.completed_days,
    Math.min(plannedTrainingDays, Math.max(currentMetrics.tonal_sessions, currentMetrics.whoop_workouts)),
  );
  const missedTrainingDays = Math.max(
    checkinSummary.missed_days,
    Math.max(0, plannedTrainingDays - completedTrainingDays),
  );
  const weeklyOutcome = evaluateWeeklyOutcome({
    isoLabel: isoWeek,
    periodStart: currentStart,
    periodEnd: currentEnd,
    plannedTrainingDays,
    completedTrainingDays,
    missedTrainingDays,
    recoveryDaysLogged: currentMetrics.days_with_recovery,
    sleepDaysLogged: currentMetrics.days_with_sleep,
    proteinDaysLogged: currentMetrics.protein_days_logged,
    proteinDaysOnTarget: currentMetrics.protein_days_on_target,
    avgRecovery: currentMetrics.avg_recovery,
    avgSleepHours: currentMetrics.avg_sleep_hours,
    avgProteinG: currentMetrics.protein_avg_daily,
    tonalSessions: currentMetrics.tonal_sessions,
    tonalVolume: currentMetrics.tonal_total_volume,
    tonalVolumeDeltaPct: trendSignals.tonal_volume.delta_pct,
    whoopStrainDeltaPct: trendSignals.strain_load.delta_pct,
    painDays: checkinSummary.pain_days,
    scheduleConflicts: checkinSummary.schedule_conflict_days,
    overreachAlerts: alertSummary.overreach_alerts,
    staleDataDays: alertSummary.freshness_alerts,
    performanceTrend: performanceTrend({
      tonalSessions: currentMetrics.tonal_sessions,
      tonalVolumeDeltaPct: trendSignals.tonal_volume.delta_pct,
      recoveryDeltaPct: trendSignals.recovery.delta_pct,
    }),
    readinessBand: riskBand,
  });

  const age100 = weeklyAge100Score({
    avgSleepHours: currentMetrics.avg_sleep_hours,
    avgRecovery: currentMetrics.avg_recovery,
    strainDelta: trendSignals.strain_load.delta,
    proteinDaysOnTarget: currentMetrics.protein_days_on_target,
    proteinDaysLogged: currentMetrics.protein_days_logged,
    errors,
    caffeineDailyAvgMg: caffeineCurrent.avg_daily_mg,
    caffeineLateDays: caffeineCurrent.late_intake_days,
  });
  const weeklyScoreWrite = upsertCoachWeeklyScore({
    isoWeek,
    weekStart: currentStart,
    weekEnd: currentEnd,
    score: age100.score,
    summary: age100.summary,
    details: {
      components: age100.components,
      trend_signals: trendSignals,
    caffeine_trends: {
      current: caffeineCurrent,
        previous: caffeinePrevious,
      },
      risk_band: riskBand,
      weekly_dose_calls: weeklyDoseCalls,
      cut_rate_risk: cutRateRisk,
      cardio_interference_risk: cardioInterferenceRisk,
    },
  });
  if (!weeklyScoreWrite.ok) errors.push(`coach_weekly_score_upsert_failed:${weeklyScoreWrite.error ?? "unknown"}`);
  const outcomeWrite = upsertCoachOutcomeEvalWeekly({
    isoWeek,
    weekStart: currentStart,
    weekEnd: currentEnd,
    overallScore: weeklyOutcome.overall_score,
    adherenceScore: weeklyOutcome.component_scores.adherence,
    recoveryAlignmentScore: weeklyOutcome.component_scores.recovery_alignment,
    nutritionAlignmentScore: weeklyOutcome.component_scores.nutrition_alignment,
    riskManagementScore: weeklyOutcome.component_scores.risk_management,
    performanceAlignmentScore: weeklyOutcome.component_scores.performance_alignment,
    explanation: {
      confidence: weeklyOutcome.confidence,
      summary: weeklyOutcome.summary,
      wins: weeklyOutcome.wins,
      misses: weeklyOutcome.misses,
      caveats: weeklyOutcome.caveats,
    },
    evidence: weeklyOutcome.evidence,
  });
  if (!outcomeWrite.ok) errors.push(`coach_outcome_eval_weekly_upsert_failed:${outcomeWrite.error ?? "unknown"}`);

  const latestHealthContext = currentRows
    .slice()
    .reverse()
    .find((row) => row.health_context && Object.keys(row.health_context).length > 0)?.health_context ?? null;

  const out = {
    generated_at: new Date().toISOString(),
    date: today,
    iso_week: isoWeek,
    weekly_file_path: weeklyTarget.sandboxFilePath,
    weekly_repo_file_path: weeklyTarget.repoFilePath,
    windows: {
      current: { start: currentStart, end: currentEnd },
      previous: { start: previousStart, end: previousEnd },
    },
    weekly_metrics: {
      current: currentMetrics,
      previous: previousMetrics,
    },
    strength_context: {
      tonal: {
        current_sessions: currentMetrics.tonal_sessions,
        current_total_volume: currentMetrics.tonal_total_volume,
        previous_sessions: previousMetrics.tonal_sessions,
        previous_total_volume: previousMetrics.tonal_total_volume,
        sessions_delta: compareMetric(currentMetrics.tonal_sessions, previousMetrics.tonal_sessions).delta,
        total_volume_delta: compareMetric(currentMetrics.tonal_total_volume, previousMetrics.tonal_total_volume).delta,
      },
    },
    training_intelligence: {
      weekly_dose_calls: weeklyDoseCalls,
      cut_rate_risk: cutRateRisk,
      cardio_interference_risk: cardioInterferenceRisk,
      weekly_training_state: weeklyPlan.trainingState,
      weekly_recommendation: weeklyPlan.recommendation,
    },
    body_composition: {
      current_avg_body_weight_kg: currentMetrics.avg_body_weight_kg,
      previous_avg_body_weight_kg: previousMetrics.avg_body_weight_kg,
      current_body_weight_days_logged: currentMetrics.body_weight_days_logged,
      previous_body_weight_days_logged: previousMetrics.body_weight_days_logged,
      avg_active_energy_kcal: currentMetrics.avg_active_energy_kcal,
      avg_resting_energy_kcal: currentMetrics.avg_resting_energy_kcal,
      avg_walking_running_distance_km: currentMetrics.avg_walking_running_distance_km,
      latest_goal_mode: latestHealthContext?.goal_mode ?? null,
      latest_weight_trend: latestHealthContext?.weekly_body_weight_trend ?? null,
    },
    trend_signals: trendSignals,
    caffeine_trends: {
      current: caffeineCurrent,
      previous: caffeinePrevious,
    },
    coaching_evidence: {
      checkins: checkinSummary,
      alerts: alertSummary,
    },
    protein_adherence_assumption: proteinAssumption,
    caffeine_summary: {
      current: caffeineCurrent,
      previous: caffeinePrevious,
    },
    age_100_alignment_score: {
      score: age100.score,
      summary: age100.summary,
      components: age100.components,
      db_status: weeklyScoreWrite.ok ? "ok" : "error",
      db_error: weeklyScoreWrite.ok ? null : weeklyScoreWrite.error ?? "unknown",
    },
    coaching_outcome_evaluation: {
      ...weeklyOutcome,
      db_status: outcomeWrite.ok ? "ok" : "error",
      db_error: outcomeWrite.ok ? null : outcomeWrite.error ?? "unknown",
    },
    hard_truth_inputs: {
      risk_band: riskBand,
      biggest_regression:
        trendSignals.recovery.delta != null && trendSignals.recovery.delta < 0
          ? "recovery"
          : trendSignals.sleep_hours.delta != null && trendSignals.sleep_hours.delta < 0
            ? "sleep"
            : "none",
      load_vs_recovery_tension:
        (trendSignals.strain_load.delta ?? 0) > 0 && (trendSignals.recovery.delta ?? 0) < 0
          ? "strain_up_recovery_down"
          : "stable_or_improving",
    },
    pending_health_insights: pendingInsights,
    surfaced_insight_ids: surfacedInsightIds,
    insight_mark_sql: markInsightsSql(surfacedInsightIds),
    errors,
  };

  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
