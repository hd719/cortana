#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { chooseSurfacedInsightIds, fetchPendingHealthInsights, markInsightsSql } from "./insights-db.js";
import { upsertFitnessDailySnapshot } from "./facts-db.js";
import { loadAppleHealthWindow } from "./health-source-service.js";
import { collectRecentMealEntries, summarizeMealRollup } from "./meal-log.js";
import { fetchCoachCaffeineDaySummary, fetchCoachNutritionRow, upsertCoachDecision } from "./coach-db.js";
import { buildAthleteStateForDate } from "./athlete-state-data.js";
import { replaceMuscleVolumeDaily, upsertAthleteStateDaily } from "./athlete-state-db.js";
import {
  buildMorningTrainingRecommendation,
  readinessEmoji,
  whoopRecoveryBandFromScore,
} from "./coaching-rules.js";
import { buildDailyRecommendation } from "./training-engine.js";
import { fetchLatestTrainingStateWeekly } from "./training-intelligence-db.js";
import { buildTodayMissionArtifact, persistTodayMissionArtifact } from "./today-mission-data.js";
import {
  buildReadinessSignal,
  computeTrend,
  dataFreshnessHours,
  extractDailyStepCount,
  extractRecoveryEntries,
  extractSleepEntries,
  extractWhoopWorkouts,
  localYmd,
  type ReadinessBand,
  type RecoveryEntry,
  tonalTodayWorkouts,
  tonalWorkoutsFromPayload as tonalWorkoutsFromPayloadCore,
} from "./signal-utils.js";

function curlJson(url: string, timeoutSec: number): unknown {
  const r = spawnSync("curl", ["-s", "--max-time", String(timeoutSec), url], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if ((r.status ?? 1) !== 0) return {};
  try {
    return JSON.parse((r.stdout ?? "").trim() || "{}");
  } catch {
    return {};
  }
}

function toObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function ymdInZone(value: string, timeZone = "America/New_York"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function tonalTodayWorkoutsWithFallback(payload: unknown, today = localYmd(), timeZone = "America/New_York") {
  const primary = tonalTodayWorkouts(payload, today, timeZone);
  if (primary.length > 0) return primary;

  return tonalWorkoutsFromPayloadCore(payload)
    .map((entry) => {
      const rawTime = typeof entry.beginTime === "string" ? entry.beginTime : "";
      const stats = toObj(entry.stats);
      const detail = toObj(entry.detail);
      const inDay = rawTime.slice(0, 10) === today || ymdInZone(rawTime, timeZone) === today;
      return {
        include: inDay,
        workout: {
          id: String(entry.id ?? entry.activityId ?? ""),
          time: rawTime,
          volume: numberOrNull(stats.totalVolume) ?? numberOrNull(entry.totalVolume),
          durationMinutes: (() => {
            const seconds = numberOrNull(entry.duration);
            if (seconds == null) return null;
            return Math.round(seconds / 60);
          })(),
          title: typeof detail.title === "string" ? detail.title : null,
        },
      };
    })
    .filter((entry) => entry.include)
    .map((entry) => entry.workout)
    .sort((a, b) => a.time.localeCompare(b.time));
}

export { buildMorningTrainingRecommendation, readinessEmoji, whoopRecoveryBandFromScore } from "./coaching-rules.js";

export function buildReadinessSupport(recoveries: RecoveryEntry[]): {
  hrv_latest: number | null;
  hrv_baseline7: number | null;
  hrv_delta_pct: number | null;
  rhr_latest: number | null;
  rhr_baseline7: number | null;
  rhr_delta: number | null;
} {
  const hrvTrend = computeTrend(recoveries.map((entry) => entry.hrv));
  const rhrTrend = computeTrend(recoveries.map((entry) => entry.rhr));
  return {
    hrv_latest: hrvTrend.latest,
    hrv_baseline7: hrvTrend.baseline7,
    hrv_delta_pct: hrvTrend.deltaPct,
    rhr_latest: rhrTrend.latest,
    rhr_baseline7: rhrTrend.baseline7,
    rhr_delta: rhrTrend.delta,
  };
}

function sleepQualityBand(sleepPerformance: number | null): "good" | "fair" | "poor" | "unknown" {
  if (sleepPerformance == null) return "unknown";
  if (sleepPerformance >= 85) return "good";
  if (sleepPerformance >= 75) return "fair";
  return "poor";
}

function toCoachReadiness(band: ReadinessBand): "Green" | "Yellow" | "Red" | "Unknown" {
  if (band === "green") return "Green";
  if (band === "yellow") return "Yellow";
  if (band === "red") return "Red";
  return "Unknown";
}

function buildLongevityImpact(opts: { band: ReadinessBand; stale: boolean }): "positive" | "neutral" | "negative" {
  if (opts.stale || opts.band === "unknown") return "neutral";
  if (opts.band === "red") return "negative";
  return "positive";
}

function buildTopRisk(opts: { band: ReadinessBand; stale: boolean; sleepPerf: number | null; caffeineYesterdayMg: number; caffeineLateYesterday: boolean }): string {
  if (opts.stale) return "Acting on stale readiness data and overreaching by mistake.";
  if (opts.band === "red") return "Pushing intensity despite low readiness and impairing recovery.";
  if (opts.caffeineLateYesterday || opts.caffeineYesterdayMg >= 300) return "High or late caffeine intake may suppress sleep recovery carryover.";
  if ((opts.sleepPerf ?? 100) < 80) return "Sleep quality drag reducing adaptation and increasing injury risk.";
  return "Turning a good readiness day into junk-volume fatigue.";
}

function previousProteinDaysLogged(entries: Array<{ date: string }>, today: string): number {
  const currentStart = localYmd("America/New_York", new Date(`${today}T12:00:00Z`));
  const previousStart = localYmd("America/New_York", new Date(Date.parse(`${currentStart}T12:00:00Z`) - 13 * 24 * 3600 * 1000));
  const previousEnd = localYmd("America/New_York", new Date(Date.parse(`${currentStart}T12:00:00Z`) - 7 * 24 * 3600 * 1000));
  return new Set(entries.filter((entry) => entry.date >= previousStart && entry.date <= previousEnd).map((entry) => entry.date)).size;
}

function main(): void {
  const errors: string[] = [];
  const generatedAt = new Date().toISOString();
  const today = localYmd();
  const yesterday = localYmd("America/New_York", new Date(Date.now() - 24 * 3600 * 1000));
  const whoop = curlJson("http://localhost:3033/whoop/data", 12);

  const tonHealthRaw = spawnSync("curl", ["-s", "--max-time", "5", "http://localhost:3033/tonal/health"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).stdout || "";
  const tonalHealth = toObj((() => {
    try {
      return JSON.parse(tonHealthRaw);
    } catch {
      errors.push("tonal_health_unavailable");
      return {};
    }
  })());

  if (!/healthy/i.test(tonHealthRaw)) {
    errors.push("tonal_not_healthy");
  }
  const tonal = /healthy/i.test(tonHealthRaw) ? curlJson("http://localhost:3033/tonal/data?fresh=true", 16) : {};

  const recoveries = extractRecoveryEntries(whoop);
  const sleeps = extractSleepEntries(whoop);
  const allWhoopWorkouts = extractWhoopWorkouts(whoop);
  const whoopWorkouts = allWhoopWorkouts.filter((entry) => entry.date === today);
  const stepSummary = extractDailyStepCount(whoop, today);
  const tonalWorkouts = tonalTodayWorkoutsWithFallback(tonal, today);
  const latestRecovery = recoveries[0] ?? null;
  const latestSleep = sleeps[0] ?? null;
  const readinessSupport = buildReadinessSupport(recoveries);
  const readinessBand = whoopRecoveryBandFromScore(latestRecovery?.recoveryScore ?? null);
  const recoveryFreshnessHours = dataFreshnessHours(latestRecovery?.createdAt ?? null);
  const sleepFreshnessHours = dataFreshnessHours(latestSleep?.createdAt ?? null);
  const isStale = (recoveryFreshnessHours ?? 99) > 18 || (sleepFreshnessHours ?? 99) > 18;
  const caffeineYesterday = fetchCoachCaffeineDaySummary(yesterday);
  const mealEntries = collectRecentMealEntries({ days: 14, agentId: "spartan" });
  const appleHealth = loadAppleHealthWindow({
    endDate: today,
    lookbackDays: 13,
  });
  if (appleHealth.error) errors.push(`apple_health:${appleHealth.error}`);
  if (appleHealth.serviceStatus === "unhealthy") errors.push("apple_health_unhealthy");
  const mealRollup = summarizeMealRollup(mealEntries, today);
  const coachNutrition = fetchCoachNutritionRow(today);
  const proteinDaysLoggedPrior = previousProteinDaysLogged(mealEntries, today);
  const legacyRecommendation = buildMorningTrainingRecommendation({
    readinessBand,
    sleepPerformance: latestSleep?.sleepPerformance ?? null,
    isStale,
  });
  const todayWhoopStrain = Number(whoopWorkouts.reduce((sum, entry) => sum + (entry.strain ?? 0), 0).toFixed(2));
  const yesterdayWhoopStrain = Number(
    allWhoopWorkouts
      .filter((entry) => entry.date === yesterday)
      .reduce((sum, entry) => sum + (entry.strain ?? 0), 0)
      .toFixed(2),
  );
  const readinessSignal = buildReadinessSignal({
    recoveryTrend: computeTrend(recoveries.map((entry) => entry.recoveryScore)),
    hrvTrend: computeTrend(recoveries.map((entry) => entry.hrv)),
    rhrTrend: computeTrend(recoveries.map((entry) => entry.rhr)),
    sleepPerformance: latestSleep?.sleepPerformance ?? null,
    freshnessHours: recoveryFreshnessHours,
    totalStrainToday: todayWhoopStrain,
    yesterdayStrain: yesterdayWhoopStrain,
  });
  const athleteStateBuild = buildAthleteStateForDate({
    stateDate: today,
    generatedAt,
    whoopPayload: whoop,
    tonalPayload: tonal,
    mealEntries,
    coachNutrition,
    healthSourceRows: appleHealth.healthRows,
  });
  const latestWeeklyTrainingState = fetchLatestTrainingStateWeekly();
  const recommendation = buildDailyRecommendation({
    readinessBand: athleteStateBuild.athleteState.readinessBand ?? "unknown",
    readinessConfidence: athleteStateBuild.athleteState.readinessConfidence ?? null,
    sleepPerformance: athleteStateBuild.athleteState.sleepPerformance ?? null,
    whoopStrain: athleteStateBuild.athleteState.whoopStrain ?? null,
    proteinTargetG: athleteStateBuild.athleteState.proteinTargetG ?? null,
    proteinG: athleteStateBuild.athleteState.proteinG ?? null,
    nutritionConfidence: athleteStateBuild.athleteState.nutritionConfidence ?? null,
    qualityFlags: athleteStateBuild.athleteState.qualityFlags ?? null,
    phaseMode: athleteStateBuild.athleteState.phaseMode ?? null,
    targetWeightDeltaPctWeek: athleteStateBuild.athleteState.targetWeightDeltaPctWeek ?? null,
    cardioMinutes: athleteStateBuild.athleteState.cardioMinutes ?? null,
    weeklyFatigueScore: latestWeeklyTrainingState?.fatigue_score ?? null,
    weeklyProgressionScore: latestWeeklyTrainingState?.progression_score ?? null,
    weeklyInterferenceRiskScore: latestWeeklyTrainingState?.interference_risk_score ?? null,
    weeklyRecommendationMode: String(latestWeeklyTrainingState?.recommendation_summary?.mode ?? ""),
    underdosedMusclesCount: Object.keys(latestWeeklyTrainingState?.underdosed_muscles ?? {}).length,
    overdosedMusclesCount: Object.keys(latestWeeklyTrainingState?.overdosed_muscles ?? {}).length,
  });
  const todayMission = buildTodayMissionArtifact({
    dateLocal: today,
    readinessScore: latestRecovery?.recoveryScore ?? null,
    sleepPerformance: latestSleep?.sleepPerformance ?? null,
    hrvLatest: readinessSupport.hrv_latest,
    rhrLatest: readinessSupport.rhr_latest,
    recoveryFreshnessHours,
    sleepFreshnessHours,
    whoopStrainToday: todayWhoopStrain,
    tonalSessionsToday: tonalWorkouts.length,
    tonalVolumeToday: Number(tonalWorkouts.reduce((sum, entry) => sum + (entry.volume ?? 0), 0).toFixed(2)),
    stepCountToday: stepSummary.stepCount,
    mealsLoggedToday: mealRollup.today.mealsLogged,
    proteinActualGToday: mealRollup.today.proteinG,
    proteinStatusToday: mealRollup.today.proteinStatus,
    proteinTargetG: mealRollup.target.proteinMinG,
    hydrationStatusToday: "unknown",
    weeklyProteinDaysLogged: mealRollup.trailing7.daysLogged,
    weeklyProteinDaysOnTarget: mealRollup.trailing7.daysMeetingProteinTarget,
    weeklyProteinDaysLoggedPrior: proteinDaysLoggedPrior,
    weeklyProteinAvgDaily: mealRollup.trailing7.avgDailyProteinG,
  });
  const todayMissionWrite = persistTodayMissionArtifact(todayMission, { agentId: "cron-fitness" });
  if (!todayMissionWrite.ok) errors.push(...todayMissionWrite.errors.map((error) => `today_mission_${error}`));

  const pendingInsights = fetchPendingHealthInsights(6);
  const surfacedInsightIds = chooseSurfacedInsightIds(
    pendingInsights,
    readinessBand === "unknown" ? "yellow" : readinessBand,
    1,
  );

  if (recoveries.length === 0) errors.push("whoop_recovery_missing");
  if (sleeps.length === 0) errors.push("whoop_sleep_missing");
  if (recoveryFreshnessHours != null && recoveryFreshnessHours > 18) errors.push("whoop_recovery_stale");
  if (sleepFreshnessHours != null && sleepFreshnessHours > 18) errors.push("whoop_sleep_stale");

  const athleteStateWrite = upsertAthleteStateDaily({
    ...athleteStateBuild.athleteState,
    recommendationMode: recommendation.mode,
    recommendationConfidence: recommendation.confidence,
  });
  if (!athleteStateWrite.ok) errors.push(`athlete_state_upsert_failed:${athleteStateWrite.error ?? "unknown"}`);
  const muscleVolumeWrite = replaceMuscleVolumeDaily(today, athleteStateBuild.muscleVolumeRows);
  if (!muscleVolumeWrite.ok) errors.push(`muscle_volume_replace_failed:${muscleVolumeWrite.error ?? "unknown"}`);

  const snapshotWrite = upsertFitnessDailySnapshot({
    snapshotDate: today,
    generatedAt,
    readinessScore: athleteStateBuild.athleteState.readinessScore,
    readinessBand: athleteStateBuild.athleteState.readinessBand,
    sleepHours: athleteStateBuild.athleteState.sleepHours,
    sleepPerformance: athleteStateBuild.athleteState.sleepPerformance,
    hrv: athleteStateBuild.athleteState.hrv,
    rhr: athleteStateBuild.athleteState.rhr,
    whoopStrain: athleteStateBuild.athleteState.whoopStrain,
    whoopStrainSource: "workouts_sum",
    stepCount: athleteStateBuild.athleteState.stepCount,
    stepSource: athleteStateBuild.athleteState.stepSource as "cycle" | "workouts_sum" | "steps_collection" | "unknown" | null,
    whoopWorkouts: athleteStateBuild.athleteState.whoopWorkouts,
    tonalSessions: athleteStateBuild.athleteState.tonalSessions,
    tonalVolume: athleteStateBuild.athleteState.tonalVolume,
    mealsLogged: mealRollup.today.mealsLogged,
    proteinG: athleteStateBuild.athleteState.proteinG,
    proteinStatus: mealRollup.today.proteinStatus,
    nutritionConfidence: athleteStateBuild.athleteState.nutritionConfidence,
    hydrationLiters: athleteStateBuild.athleteState.hydrationLiters,
    hydrationSource: coachNutrition?.date_local ? "coach_nutrition_log" : mealRollup.today.hydrationLiters != null ? "meal_log" : null,
    dataIsStale: isStale,
    qualityFlags: {
      ...(athleteStateBuild.athleteState.qualityFlags ?? {}),
      has_whoop: recoveries.length > 0 && sleeps.length > 0,
    },
    raw: {
      source: "morning_brief",
      errors,
    },
  });
  if (!snapshotWrite.ok) errors.push(`fitness_daily_snapshot_upsert_failed:${snapshotWrite.error ?? "unknown"}`);

  const decisionWrite = upsertCoachDecision({
    tsUtc: generatedAt,
    readinessCall: toCoachReadiness(athleteStateBuild.athleteState.readinessBand ?? "unknown"),
    longevityImpact: buildLongevityImpact({ band: athleteStateBuild.athleteState.readinessBand ?? "unknown", stale: isStale }),
    topRisk: recommendation.topRisk,
    reasonSummary: recommendation.rationale,
    prescribedAction: legacyRecommendation.concrete_action,
    actualDayStrain: athleteStateBuild.athleteState.whoopStrain ?? todayWhoopStrain,
    sleepPerfPct: athleteStateBuild.athleteState.sleepPerformance,
    recoveryScore: athleteStateBuild.athleteState.readinessScore,
    sourceStateDate: today,
    decisionKey: `spartan:decision:morning:${today}`,
    payload: {
      recommendation,
      legacy_recommendation: legacyRecommendation,
      readiness_signal: readinessSignal,
      today_mission_key: todayMission.mission_key,
      tonal_sessions_today: tonalWorkouts.length,
      protein_status_today: mealRollup.today.proteinStatus,
      recommendation_confidence: recommendation.confidence,
    },
  });
  if (!decisionWrite.ok) errors.push(`coach_decision_upsert_failed:${decisionWrite.error ?? "unknown"}`);

  const out = {
    generated_at: generatedAt,
    date: today,
    morning_readiness: {
      score: latestRecovery?.recoveryScore ?? null,
      band: readinessBand,
      color_emoji: readinessEmoji(readinessBand),
      source: "whoop_recovery_score",
      freshness_hours: recoveryFreshnessHours,
    },
    last_night_sleep: {
      performance: latestSleep?.sleepPerformance ?? null,
      quality_band: sleepQualityBand(latestSleep?.sleepPerformance ?? null),
      hours: latestSleep?.sleepHours ?? null,
      efficiency: latestSleep?.sleepEfficiency ?? null,
      freshness_hours: sleepFreshnessHours,
    },
    readiness_support_signals: readinessSupport,
    readiness_signal: readinessSignal,
    caffeine_context: {
      yesterday_total_mg: caffeineYesterday.total_mg,
      yesterday_entries: caffeineYesterday.entries,
      yesterday_after_1pm: caffeineYesterday.latest_after_cutoff,
      yesterday_latest_local_time: caffeineYesterday.latest_local_time,
    },
    today_training_context: {
      whoop_workouts_today: whoopWorkouts.length,
      whoop_total_strain_today: Number(whoopWorkouts.reduce((sum, entry) => sum + (entry.strain ?? 0), 0).toFixed(2)),
      whoop_steps_today: stepSummary.stepCount,
      whoop_steps_source: stepSummary.source,
      tonal_sessions_today: tonalWorkouts.length,
      tonal_total_volume_today: Number(tonalWorkouts.reduce((sum, entry) => sum + (entry.volume ?? 0), 0).toFixed(2)),
      tonal_workouts: tonalWorkouts.slice(0, 5).map((entry) => ({
        id: entry.id,
        time: entry.time,
        volume: entry.volume,
        duration_minutes: entry.durationMinutes,
        title: entry.title,
      })),
    },
    today_training_recommendation: recommendation,
    athlete_state: athleteStateBuild.athleteState,
    weekly_training_state: latestWeeklyTrainingState,
    muscle_volume_today: athleteStateBuild.muscleVolumeRows,
    today_mission: todayMission,
    today_mission_file_path: todayMissionWrite.sandboxFilePath,
    today_mission_repo_file_path: todayMissionWrite.repoFilePath,
    today_mission_write: {
      status: todayMissionWrite.ok ? "ok" : "error",
      sandbox: todayMissionWrite.sandboxWrite,
      repo_mirror: todayMissionWrite.repoMirrorWrite,
      errors: todayMissionWrite.errors,
    },
    data_freshness: {
      is_stale: isStale,
      recovery_hours: recoveryFreshnessHours,
      sleep_hours: sleepFreshnessHours,
      apple_health_status: appleHealth.serviceStatus,
    },
    pending_health_insights: pendingInsights,
    surfaced_insight_ids: surfacedInsightIds,
    insight_mark_sql: markInsightsSql(surfacedInsightIds),
    db_snapshot: {
      table: "cortana_fitness_daily_facts",
      status: snapshotWrite.ok ? "ok" : "error",
      error: snapshotWrite.ok ? null : snapshotWrite.error ?? "unknown",
    },
    coach_decision_log: {
      table: "coach_decision_log",
      status: decisionWrite.ok ? "ok" : "error",
      error: decisionWrite.ok ? null : decisionWrite.error ?? "unknown",
    },
    athlete_state_log: {
      table: "cortana_fitness_athlete_state_daily",
      status: athleteStateWrite.ok ? "ok" : "error",
      error: athleteStateWrite.ok ? null : athleteStateWrite.error ?? "unknown",
    },
    muscle_volume_log: {
      table: "cortana_fitness_muscle_volume_daily",
      status: muscleVolumeWrite.ok ? "ok" : "error",
      error: muscleVolumeWrite.ok ? null : muscleVolumeWrite.error ?? "unknown",
    },
    errors,
    quality_flags: {
      has_whoop: recoveries.length > 0 && sleeps.length > 0,
      has_recovery_score: latestRecovery?.recoveryScore != null,
      has_hrv_signal: readinessSupport.hrv_latest != null,
      has_rhr_signal: readinessSupport.rhr_latest != null,
      has_sleep_signal: latestSleep?.sleepPerformance != null,
      has_tonal_today: tonalWorkouts.length > 0,
      has_meal_logs: mealRollup.today.mealsLogged > 0,
      has_apple_health: appleHealth.healthRows.length > 0,
    },
    apple_health: {
      status: appleHealth.serviceStatus,
      rows_loaded: appleHealth.healthRows.length,
      rows_ingested: appleHealth.ingestedRowCount,
      ignored_metrics: appleHealth.ignoredMetricCount,
      write_status: appleHealth.writeResult?.ok === false ? "error" : "ok",
      write_error: appleHealth.writeResult?.ok === false ? appleHealth.writeResult.error ?? "unknown" : null,
    },
    tonal_health: tonalHealth,
  };

  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
