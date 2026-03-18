#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { collectRecentMealEntries, summarizeMealRollup } from "./meal-log.js";
import { chooseSurfacedInsightIds, fetchPendingHealthInsights, markInsightsSql } from "./insights-db.js";
import {
  buildReadinessSignal,
  computeTrend,
  dataFreshnessHours,
  extractRecoveryEntries,
  extractSleepEntries,
  extractWhoopWorkouts,
  localYmd,
  overreachFlags,
  summarizeWhoopWeekly,
  summarizeTonalWeekly,
  tonalTodayWorkouts,
} from "./signal-utils.js";

function curlJson(url: string, timeoutSec: number): unknown {
  const r = spawnSync("curl", ["-s", "--max-time", String(timeoutSec), url], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
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

function main(): void {
  const errors: string[] = [];
  const today = localYmd();
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

  const tonal = /healthy/i.test(tonHealthRaw) ? curlJson("http://localhost:3033/tonal/data?fresh=true", 16) : {};
  if (!/healthy/i.test(tonHealthRaw)) {
    errors.push("tonal_not_healthy");
  }

  const recoveries = extractRecoveryEntries(whoop);
  const sleeps = extractSleepEntries(whoop);
  const whoopWorkouts = extractWhoopWorkouts(whoop);
  const whoopToday = whoopWorkouts.filter((workout) => workout.date === today);
  const tonalToday = tonalTodayWorkouts(tonal, today);

  const recoveryTrend = computeTrend(recoveries.map((item) => item.recoveryScore));
  const hrvTrend = computeTrend(recoveries.map((item) => item.hrv));
  const rhrTrend = computeTrend(recoveries.map((item) => item.rhr));
  const sleepPerformance = sleeps.length ? sleeps[0].sleepPerformance : null;
  const recoveryFreshnessHours = dataFreshnessHours(recoveries.length ? recoveries[0].createdAt : null);
  const sleepFreshnessHours = dataFreshnessHours(sleeps.length ? sleeps[0].createdAt : null);
  const totalStrainToday = Number(
    whoopToday.reduce((sum, workout) => sum + (workout.strain ?? 0), 0).toFixed(2),
  );
  const yesterday = whoopWorkouts.filter((workout) => workout.date === localYmd("America/New_York", new Date(Date.now() - 24 * 3600 * 1000)));
  const yesterdayStrain = Number(yesterday.reduce((sum, workout) => sum + (workout.strain ?? 0), 0).toFixed(2));

  const readiness = buildReadinessSignal({
    recoveryTrend,
    hrvTrend,
    rhrTrend,
    sleepPerformance,
    freshnessHours: recoveryFreshnessHours,
    totalStrainToday,
    yesterdayStrain,
  });

  const pendingInsights = fetchPendingHealthInsights(6);
  const surfacedInsightIds = chooseSurfacedInsightIds(pendingInsights, readiness.band, 2);
  const mealEntries = collectRecentMealEntries({ days: 7, agentId: "spartan" });
  const mealRollup = summarizeMealRollup(mealEntries, today);
  const overreach = overreachFlags({
    recoveryScore: recoveryTrend.latest,
    totalStrainToday,
    yesterdayStrain,
  });
  const whoopWeekly = summarizeWhoopWeekly(whoop, today);
  const tonalWeekly = summarizeTonalWeekly(tonal);

  if (recoveries.length === 0) errors.push("whoop_recovery_missing");
  if (sleeps.length === 0) errors.push("whoop_sleep_missing");
  if (recoveryFreshnessHours != null && recoveryFreshnessHours > 18) errors.push("whoop_recovery_stale");
  if (sleepFreshnessHours != null && sleepFreshnessHours > 18) errors.push("whoop_sleep_stale");

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
    strain: {
      total_today: totalStrainToday,
      total_yesterday: yesterdayStrain,
      overreach_flags: overreach,
    },
    recovery_latest: recoveries[0] ?? null,
    sleep_latest: sleeps[0] ?? null,
    whoop_today_workouts: whoopToday.slice(0, 5),
    tonal_today_workouts: tonalToday.slice(0, 5),
    whoop_weekly: whoopWeekly,
    tonal_weekly: tonalWeekly,
    meal_rollup: mealRollup,
    pending_health_insights: pendingInsights,
    surfaced_insight_ids: surfacedInsightIds,
    insight_mark_sql: markInsightsSql(surfacedInsightIds),
    errors,
    quality_flags: {
      has_whoop: recoveries.length > 0 && sleeps.length > 0,
      has_tonal_today: tonalToday.length > 0,
      meal_logs_found: mealEntries.length,
      protein_today_g: numberOrNull(mealRollup.today.proteinG),
    },
  };

  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main();
