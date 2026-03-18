#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import path from "node:path";
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
  summarizeTonalWeekly,
  summarizeWhoopWeekly,
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

function currentIsoWeekTag(date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function main(): void {
  const errors: string[] = [];
  const today = localYmd();
  const whoop = curlJson("http://127.0.0.1:3033/whoop/data", 14);
  const tonalHealthRaw = spawnSync("curl", ["-s", "--max-time", "5", "http://127.0.0.1:3033/tonal/health"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).stdout || "";
  const tonal = /healthy/i.test(tonalHealthRaw) ? curlJson("http://127.0.0.1:3033/tonal/data?fresh=true", 20) : {};
  if (!/healthy/i.test(tonalHealthRaw)) errors.push("tonal_not_healthy");

  const recoveries = extractRecoveryEntries(whoop);
  const sleeps = extractSleepEntries(whoop);
  const workouts = extractWhoopWorkouts(whoop);
  const whoopWeekly = summarizeWhoopWeekly(whoop, today);
  const tonalWeekly = summarizeTonalWeekly(tonal);
  const recoveryTrend = computeTrend(recoveries.map((entry) => entry.recoveryScore));
  const hrvTrend = computeTrend(recoveries.map((entry) => entry.hrv));
  const rhrTrend = computeTrend(recoveries.map((entry) => entry.rhr));
  const sleepPerformance = sleeps[0]?.sleepPerformance ?? null;
  const totalStrainToday = Number(workouts.filter((entry) => entry.date === today).reduce((sum, entry) => sum + (entry.strain ?? 0), 0).toFixed(2));
  const yesterday = localYmd("America/New_York", new Date(Date.now() - 24 * 3600 * 1000));
  const yesterdayStrain = Number(workouts.filter((entry) => entry.date === yesterday).reduce((sum, entry) => sum + (entry.strain ?? 0), 0).toFixed(2));
  const readiness = buildReadinessSignal({
    recoveryTrend,
    hrvTrend,
    rhrTrend,
    sleepPerformance,
    freshnessHours: dataFreshnessHours(recoveries[0]?.createdAt ?? null),
    totalStrainToday,
    yesterdayStrain,
  });

  const mealEntries = collectRecentMealEntries({ days: 7, agentId: "spartan" });
  const mealRollup = summarizeMealRollup(mealEntries, today);
  const pendingInsights = fetchPendingHealthInsights(8);
  const surfacedInsightIds = chooseSurfacedInsightIds(pendingInsights, readiness.band, 2);
  const isoWeek = currentIsoWeekTag();
  const weeklyFilePath = path.join("/Users/hd/Developer/cortana/memory/fitness/weekly", `${isoWeek}.md`);

  if (recoveries.length === 0) errors.push("whoop_recovery_missing");
  if (sleeps.length === 0) errors.push("whoop_sleep_missing");

  const out = {
    generated_at: new Date().toISOString(),
    date: today,
    iso_week: isoWeek,
    weekly_file_path: weeklyFilePath,
    readiness,
    whoop_weekly: whoopWeekly,
    tonal_weekly: tonalWeekly,
    meal_rollup: mealRollup,
    trends: {
      recovery: recoveryTrend,
      hrv: hrvTrend,
      rhr: rhrTrend,
    },
    pending_health_insights: pendingInsights,
    surfaced_insight_ids: surfacedInsightIds,
    insight_mark_sql: markInsightsSql(surfacedInsightIds),
    errors,
  };

  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main();

