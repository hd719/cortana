#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { collectRecentMealEntries, summarizeMealRollup } from "./meal-log.js";
import { chooseSurfacedInsightIds, fetchPendingHealthInsights, markInsightsSql } from "./insights-db.js";
import {
  buildReadinessSignal,
  buildTomorrowOutlook,
  computeTrend,
  dataFreshnessHours,
  extractRecoveryEntries,
  extractSleepEntries,
  extractWhoopWorkouts,
  localYmd,
  summarizeTonalWeekly,
  summarizeWhoopWeekly,
  tonalTodayWorkouts as tonalTodayWorkoutsCore,
  tonalWorkoutsFromPayload as tonalWorkoutsFromPayloadCore,
} from "./signal-utils.js";

type JsonObject = Record<string, unknown>;

export type TonalWorkoutSummary = {
  id: string;
  time: string;
  volume: number | null;
  duration_minutes: number | null;
  title: string | null;
};

export type WhoopSummary = {
  recovery: number | null;
  sleep_performance: number | null;
  total_strain_today: number;
};

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

function toObj(v: unknown): JsonObject {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {};
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function tonalWorkoutsFromPayload(payload: unknown): JsonObject[] {
  return tonalWorkoutsFromPayloadCore(payload) as JsonObject[];
}

export function tonalTodayWorkouts(payload: unknown, today = localYmd()): TonalWorkoutSummary[] {
  return tonalTodayWorkoutsCore(payload, today).map((entry) => ({
    id: entry.id,
    time: entry.time,
    volume: entry.volume,
    duration_minutes: entry.durationMinutes,
    title: entry.title,
  }));
}

export function buildWhoopSummary(payload: unknown, today = localYmd()): WhoopSummary {
  const recoveries = extractRecoveryEntries(payload);
  const sleeps = extractSleepEntries(payload);
  const workouts = extractWhoopWorkouts(payload).filter((entry) => entry.date === today);
  return {
    recovery: recoveries[0]?.recoveryScore ?? null,
    sleep_performance: sleeps[0]?.sleepPerformance ?? null,
    total_strain_today: Number(workouts.reduce((sum, entry) => sum + (entry.strain ?? 0), 0).toFixed(2)),
  };
}

function main(): void {
  const errors: string[] = [];
  const today = localYmd();
  const whoop = curlJson("http://127.0.0.1:3033/whoop/data", 14);

  const tonalHealthRaw = spawnSync("curl", ["-s", "--max-time", "5", "http://127.0.0.1:3033/tonal/health"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).stdout || "";
  const tonalHealth = toObj((() => {
    try {
      return JSON.parse(tonalHealthRaw);
    } catch {
      errors.push("tonal_health_unavailable");
      return {};
    }
  })());
  let tonal = /healthy/i.test(tonalHealthRaw) ? curlJson("http://127.0.0.1:3033/tonal/data?fresh=true", 20) : {};
  let todayWorkouts = tonalTodayWorkouts(tonal, today);

  if (todayWorkouts.length === 0) {
    tonal = curlJson("http://127.0.0.1:3033/tonal/data?fresh=true", 20);
    todayWorkouts = tonalTodayWorkouts(tonal, today);
  }

  const recoveries = extractRecoveryEntries(whoop);
  const sleeps = extractSleepEntries(whoop);
  const whoopWorkouts = extractWhoopWorkouts(whoop);
  const whoopToday = whoopWorkouts.filter((workout) => workout.date === today);
  const yesterday = whoopWorkouts.filter((workout) => workout.date === localYmd("America/New_York", new Date(Date.now() - 24 * 3600 * 1000)));

  const recoveryTrend = computeTrend(recoveries.map((entry) => entry.recoveryScore));
  const hrvTrend = computeTrend(recoveries.map((entry) => entry.hrv));
  const rhrTrend = computeTrend(recoveries.map((entry) => entry.rhr));
  const sleepPerformance = sleeps.length ? sleeps[0].sleepPerformance : null;
  const totalStrainToday = Number(whoopToday.reduce((sum, entry) => sum + (entry.strain ?? 0), 0).toFixed(2));
  const yesterdayStrain = Number(yesterday.reduce((sum, entry) => sum + (entry.strain ?? 0), 0).toFixed(2));
  const recoveryFreshnessHours = dataFreshnessHours(recoveries.length ? recoveries[0].createdAt : null);
  const sleepFreshnessHours = dataFreshnessHours(sleeps.length ? sleeps[0].createdAt : null);
  const readiness = buildReadinessSignal({
    recoveryTrend,
    hrvTrend,
    rhrTrend,
    sleepPerformance,
    freshnessHours: recoveryFreshnessHours,
    totalStrainToday,
    yesterdayStrain,
  });
  const tomorrowOutlook = buildTomorrowOutlook({
    readiness,
    totalStrainToday,
    sleepPerformance,
  });

  const pendingInsights = fetchPendingHealthInsights(6);
  const surfacedInsightIds = chooseSurfacedInsightIds(pendingInsights, readiness.band, 2);
  const mealEntries = collectRecentMealEntries({ days: 7, agentId: "spartan" });
  const mealRollup = summarizeMealRollup(mealEntries, today);
  const whoopWeekly = summarizeWhoopWeekly(whoop, today);
  const tonalWeekly = summarizeTonalWeekly(tonal);

  if (recoveries.length === 0) errors.push("whoop_recovery_missing");
  if (sleeps.length === 0) errors.push("whoop_sleep_missing");
  if ((recoveryFreshnessHours ?? 99) > 18) errors.push("whoop_recovery_stale");
  if ((sleepFreshnessHours ?? 99) > 18) errors.push("whoop_sleep_stale");
  if (!/healthy/i.test(tonalHealthRaw)) errors.push("tonal_not_healthy");

  const out = {
    generated_at: new Date().toISOString(),
    date: today,
    readiness,
    data_freshness: {
      recovery_hours: recoveryFreshnessHours,
      sleep_hours: sleepFreshnessHours,
      is_stale: (recoveryFreshnessHours ?? 99) > 18 || (sleepFreshnessHours ?? 99) > 18,
    },
    trends: {
      recovery: recoveryTrend,
      hrv: hrvTrend,
      rhr: rhrTrend,
    },
    whoop_recovery_latest: recoveries[0] ?? null,
    whoop_sleep_latest: sleeps[0] ?? null,
    whoop_today_summary: buildWhoopSummary(whoop, today),
    whoop_today_workouts: whoopToday.slice(0, 8),
    tonal_today_workouts: todayWorkouts,
    whoop_weekly: whoopWeekly,
    tonal_weekly: tonalWeekly,
    meal_rollup: mealRollup,
    tomorrow_outlook: tomorrowOutlook,
    pending_health_insights: pendingInsights,
    surfaced_insight_ids: surfacedInsightIds,
    insight_mark_sql: markInsightsSql(surfacedInsightIds),
    errors,
    quality_flags: {
      has_whoop: recoveries.length > 0 && sleeps.length > 0,
      has_tonal: numberOrNull(tonalWeekly.workouts) !== null,
      has_meal_logs: mealEntries.length > 0,
    },
    tonal_health: tonalHealth,
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
