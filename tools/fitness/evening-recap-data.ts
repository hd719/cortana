#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { collectRecentMealEntries, summarizeMealRollup } from "./meal-log.js";
import { chooseSurfacedInsightIds, fetchPendingHealthInsights, markInsightsSql } from "./insights-db.js";
import { upsertFitnessDailySnapshot } from "./facts-db.js";
import { fetchCoachCaffeineDaySummary, upsertCoachDecision, upsertCoachNutrition } from "./coach-db.js";
import {
  dataFreshnessHours,
  extractDailyStepCount,
  extractRecoveryEntries,
  extractSleepEntries,
  extractWhoopWorkouts,
  localYmd,
  tonalTodayWorkouts as tonalTodayWorkoutsCore,
  tonalWorkoutsFromPayload as tonalWorkoutsFromPayloadCore,
  type ReadinessBand,
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
  total_strain_today: number;
  cycle_strain_today: number | null;
  workouts_strain_sum_today: number;
  strain_source: "cycle" | "workouts_sum";
  whoop_workouts_today: number;
  top_sports_today: string[];
};

export type NutritionAssumption = {
  status: "observed_from_logs" | "assume_likely_below_target_unverified" | "assume_inconsistent_unverified";
  confidence: "high" | "medium" | "low";
  rationale: string;
  coaching_note: string;
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

export function readinessEmoji(band: ReadinessBand): string {
  if (band === "green") return "🟢";
  if (band === "yellow") return "🟡";
  if (band === "red") return "🔴";
  return "⚪";
}

function strainBand(totalStrain: number): ReadinessBand {
  if (totalStrain >= 16) return "red";
  if (totalStrain >= 10) return "yellow";
  return "green";
}


function toCoachReadiness(band: ReadinessBand): "Green" | "Yellow" | "Red" | "Unknown" {
  if (band === "green") return "Green";
  if (band === "yellow") return "Yellow";
  if (band === "red") return "Red";
  return "Unknown";
}

function longevityFromLoad(totalStrain: number): "positive" | "neutral" | "negative" {
  if (totalStrain >= 18) return "negative";
  if (totalStrain >= 12) return "neutral";
  return "positive";
}

export function tonalWorkoutsFromPayload(payload: unknown): JsonObject[] {
  return tonalWorkoutsFromPayloadCore(payload) as JsonObject[];
}

function mapTonalWorkout(entry: {
  id: string;
  time: string;
  volume: number | null;
  durationMinutes: number | null;
  title: string | null;
}): TonalWorkoutSummary {
  return {
    id: entry.id,
    time: entry.time,
    volume: entry.volume,
    duration_minutes: entry.durationMinutes,
    title: entry.title,
  };
}

export function tonalTodayWorkouts(payload: unknown, today = localYmd(), timeZone = "America/New_York"): TonalWorkoutSummary[] {
  const primary = tonalTodayWorkoutsCore(payload, today, timeZone).map(mapTonalWorkout);
  if (primary.length > 0) return primary;

  // Fallback for payloads where timezone parsing drifts but beginTime has the local date prefix.
  const fallback = tonalWorkoutsFromPayloadCore(payload)
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
          duration_minutes: (() => {
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

  return fallback;
}

export function buildWhoopSummary(payload: unknown, today = localYmd()): WhoopSummary {
  const workouts = extractWhoopWorkouts(payload).filter((entry) => entry.date === today);
  const workoutsStrainSum = Number(workouts.reduce((sum, entry) => sum + (entry.strain ?? 0), 0).toFixed(2));

  const root = toObj(payload);
  const cycles = Array.isArray(root.cycles) ? root.cycles : [];
  const cycleStrainToday = cycles
    .map((entry) => {
      const row = toObj(entry);
      const score = toObj(row.score);
      const ts = typeof row.created_at === "string" ? row.created_at : (typeof row.start === "string" ? row.start : "");
      return {
        date: ts ? ymdInZone(ts) : "",
        ts: typeof row.updated_at === "string" ? row.updated_at : (typeof row.created_at === "string" ? row.created_at : ts),
        strain: numberOrNull(score.strain),
      };
    })
    .filter((entry) => entry.date === today)
    .sort((a, b) => b.ts.localeCompare(a.ts))[0]?.strain ?? null;

  const totalStrainToday = cycleStrainToday ?? workoutsStrainSum;
  const bySport = new Map<string, number>();
  for (const workout of workouts) {
    const key = workout.sport.toLowerCase();
    bySport.set(key, (bySport.get(key) ?? 0) + 1);
  }
  const topSports = Array.from(bySport.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([sport]) => sport);
  return {
    total_strain_today: totalStrainToday,
    cycle_strain_today: cycleStrainToday,
    workouts_strain_sum_today: workoutsStrainSum,
    strain_source: cycleStrainToday != null ? "cycle" : "workouts_sum",
    whoop_workouts_today: workouts.length,
    top_sports_today: topSports,
  };
}

function buildTonightSleepTarget(opts: {
  totalStrainToday: number;
  tonalSessions: number;
  proteinStatus: "below" | "on_target" | "above" | "unknown";
}): {
  min_hours: number;
  goal_hours: number;
  lights_out_local: string;
  reason: string;
  concrete_action: string;
} {
  let goalHours = 7.5;
  if (opts.totalStrainToday >= 14 || opts.tonalSessions >= 2) goalHours = 8;
  if (opts.totalStrainToday >= 18) goalHours = 8.25;
  if (opts.proteinStatus === "below") goalHours += 0.25;
  const cappedGoal = Number(Math.min(8.5, goalHours).toFixed(2));
  return {
    min_hours: 7.5,
    goal_hours: cappedGoal,
    lights_out_local: "22:15",
    reason: "High training load needs a larger sleep window to keep tomorrow from sliding.",
    concrete_action: `Set lights-out for 10:15 PM ET and protect a ${cappedGoal}h sleep window.`,
  };
}

export function buildNutritionAssumption(opts: {
  mealsLogged: number;
  proteinStatus: "below" | "on_target" | "above" | "unknown";
  totalStrainToday: number;
  tonalSessions: number;
}): NutritionAssumption {
  if (opts.mealsLogged > 0) {
    return {
      status: "observed_from_logs",
      confidence: opts.mealsLogged >= 2 ? "high" : "medium",
      rationale: "Meal logs exist, so protein status is based on observed intake.",
      coaching_note:
        opts.proteinStatus === "below"
          ? "Protein is below target; close the gap tonight."
          : "Protein signal is observed; stay consistent with target intake.",
    };
  }

  if (opts.totalStrainToday >= 10 || opts.tonalSessions > 0) {
    return {
      status: "assume_likely_below_target_unverified",
      confidence: "low",
      rationale: "No meals logged on a meaningful training-load day; default to under-fueling risk.",
      coaching_note: "Treat protein as likely below target until intake is logged.",
    };
  }

  return {
    status: "assume_inconsistent_unverified",
    confidence: "low",
    rationale: "No meals logged; adherence cannot be verified.",
    coaching_note: "Assume inconsistent fueling and re-establish logging tomorrow.",
  };
}

function extractWhoopHydrationLiters(payload: unknown): { liters: number | null; source: string | null } {
  const root = toObj(payload);
  const hydration = toObj(root.hydration);
  const score = toObj(hydration.score);
  const directLiters =
    numberOrNull(hydration.water_liters) ??
    numberOrNull(hydration.hydration_liters) ??
    numberOrNull(score.water_liters) ??
    numberOrNull(score.hydration_liters);
  if (directLiters != null) return { liters: Number(directLiters.toFixed(3)), source: "whoop_payload.hydration" };

  const body = toObj(root.body_measurement);
  const bodyHydrationPct = numberOrNull(body.hydration_percent ?? body.hydration_percentage);
  if (bodyHydrationPct != null) return { liters: null, source: "whoop_payload.body_measurement_pct_only" };

  return { liters: null, source: null };
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
  const tonal = /healthy/i.test(tonalHealthRaw) ? curlJson("http://127.0.0.1:3033/tonal/data?fresh=true", 20) : {};
  if (!/healthy/i.test(tonalHealthRaw)) errors.push("tonal_not_healthy");

  const whoopSummary = buildWhoopSummary(whoop, today);
  const stepSummary = extractDailyStepCount(whoop, today);
  const todayWorkouts = tonalTodayWorkouts(tonal, today);
  const totalTonalVolume = Number(todayWorkouts.reduce((sum, item) => sum + (item.volume ?? 0), 0).toFixed(2));
  const totalTonalDuration = Number(todayWorkouts.reduce((sum, item) => sum + (item.duration_minutes ?? 0), 0).toFixed(2));

  const mealEntries = collectRecentMealEntries({ days: 7, agentId: "spartan" });
  const mealRollup = summarizeMealRollup(mealEntries, today);
  const nutritionAssumption = buildNutritionAssumption({
    mealsLogged: mealRollup.today.mealsLogged,
    proteinStatus: mealRollup.today.proteinStatus,
    totalStrainToday: whoopSummary.total_strain_today,
    tonalSessions: todayWorkouts.length,
  });
  const sleepTarget = buildTonightSleepTarget({
    totalStrainToday: whoopSummary.total_strain_today,
    tonalSessions: todayWorkouts.length,
    proteinStatus: mealRollup.today.proteinStatus,
  });
  const loadBand = strainBand(whoopSummary.total_strain_today);
  const hydration = extractWhoopHydrationLiters(whoop);
  const caffeineSummary = fetchCoachCaffeineDaySummary(today);

  const recoveries = extractRecoveryEntries(whoop);
  const sleeps = extractSleepEntries(whoop);
  const recoveryFreshnessHours = dataFreshnessHours(recoveries[0]?.createdAt ?? null);
  const sleepFreshnessHours = dataFreshnessHours(sleeps[0]?.createdAt ?? null);
  if (recoveries.length === 0) errors.push("whoop_recovery_missing");
  if (sleeps.length === 0) errors.push("whoop_sleep_missing");
  if ((recoveryFreshnessHours ?? 99) > 18) errors.push("whoop_recovery_stale");
  if ((sleepFreshnessHours ?? 99) > 18) errors.push("whoop_sleep_stale");

  const pendingInsights = fetchPendingHealthInsights(6);
  const surfacedInsightIds = chooseSurfacedInsightIds(
    pendingInsights,
    loadBand === "green" ? "yellow" : loadBand,
    1,
  );

  const snapshotWrite = upsertFitnessDailySnapshot({
    snapshotDate: today,
    generatedAt: new Date().toISOString(),
    whoopStrain: whoopSummary.total_strain_today,
    whoopStrainSource: whoopSummary.strain_source,
    stepCount: stepSummary.stepCount,
    stepSource: stepSummary.source,
    whoopWorkouts: whoopSummary.whoop_workouts_today,
    tonalSessions: todayWorkouts.length,
    tonalVolume: totalTonalVolume,
    mealsLogged: mealRollup.today.mealsLogged,
    proteinG: mealRollup.today.proteinG,
    proteinStatus: mealRollup.today.proteinStatus,
    nutritionConfidence: nutritionAssumption.confidence,
    hydrationLiters: hydration.liters,
    hydrationSource: hydration.source,
    dataIsStale: (recoveryFreshnessHours ?? 99) > 18 || (sleepFreshnessHours ?? 99) > 18,
    qualityFlags: {
      has_whoop_training: whoopSummary.whoop_workouts_today > 0,
      has_tonal_training: todayWorkouts.length > 0,
      has_meal_logs: mealEntries.length > 0,
      has_hydration_signal: hydration.liters != null,
    },
    raw: {
      source: "evening_recap",
      load_band: loadBand,
      nutrition_assumption: nutritionAssumption,
      errors,
    },
  });
  if (!snapshotWrite.ok) errors.push(`fitness_daily_snapshot_upsert_failed:${snapshotWrite.error ?? "unknown"}`);

  const hydrationStatus = hydration.liters == null
    ? "unknown"
    : hydration.liters >= 2.5
      ? "on_track"
      : hydration.liters >= 1.5
        ? "moderate"
        : "low";

  const nutritionWrite = upsertCoachNutrition({
    dateLocal: today,
    proteinTargetG: mealRollup.target.proteinMinG,
    proteinActualG: mealRollup.today.proteinG == null ? null : Math.round(mealRollup.today.proteinG),
    hydrationStatus,
    notes: nutritionAssumption.coaching_note,
  });
  if (!nutritionWrite.ok) errors.push(`coach_nutrition_upsert_failed:${nutritionWrite.error ?? "unknown"}`);

  const highCaffeine = caffeineSummary.total_mg >= 300;
  const lateCaffeine = caffeineSummary.latest_after_cutoff;
  const overreachWarning = whoopSummary.total_strain_today >= 14 || highCaffeine || lateCaffeine;
  const decisionWrite = upsertCoachDecision({
    tsUtc: new Date().toISOString(),
    readinessCall: toCoachReadiness(loadBand),
    longevityImpact: longevityFromLoad(whoopSummary.total_strain_today),
    topRisk: overreachWarning
      ? (lateCaffeine
          ? "Late caffeine plus training stress likely to reduce sleep quality and recovery."
          : highCaffeine
            ? "High caffeine load may mask fatigue and degrade sleep recovery."
            : "Stacking another hard session before recovery closes.")
      : "Inconsistent sleep and nutrition reducing adaptation quality.",
    reasonSummary: `Evening load band ${loadBand} from strain ${whoopSummary.total_strain_today} and nutrition status ${mealRollup.today.proteinStatus}.`,
    prescribedAction: sleepTarget.concrete_action,
    actualDayStrain: whoopSummary.total_strain_today,
    sleepPerfPct: sleeps[0]?.sleepPerformance ?? null,
    recoveryScore: recoveries[0]?.recoveryScore ?? null,
    sourceStateDate: today,
    decisionKey: `spartan:decision:evening:${today}`,
    payload: {
      load_band: loadBand,
      whoop_summary: whoopSummary,
      nutrition_assumption: nutritionAssumption,
      sleep_target: sleepTarget,
      hydration_status: hydrationStatus,
    },
  });
  if (!decisionWrite.ok) errors.push(`coach_decision_upsert_failed:${decisionWrite.error ?? "unknown"}`);

  const out = {
    generated_at: new Date().toISOString(),
    date: today,
    today_training_output: {
      whoop: whoopSummary,
      steps: {
        daily_steps: stepSummary.stepCount,
        source: stepSummary.source,
      },
      tonal: {
        sessions_today: todayWorkouts.length,
        total_volume_today: totalTonalVolume,
        total_duration_minutes_today: totalTonalDuration,
        workouts: todayWorkouts.slice(0, 8),
      },
      load_signal: {
        band: loadBand,
        color_emoji: readinessEmoji(loadBand),
      },
    },
    today_nutrition: {
      caffeine: {
        total_mg: caffeineSummary.total_mg,
        entries: caffeineSummary.entries,
        latest_local_time: caffeineSummary.latest_local_time,
        after_1pm: caffeineSummary.latest_after_cutoff,
      },
      protein_target_g: {
        min: mealRollup.target.proteinMinG,
        max: mealRollup.target.proteinMaxG,
      },
      meals_logged: mealRollup.today.mealsLogged,
      protein_g: mealRollup.today.proteinG,
      protein_status: mealRollup.today.proteinStatus,
      protein_gap_g: mealRollup.today.proteinGapG,
      calories: mealRollup.today.calories,
      carbs_g: mealRollup.today.carbsG,
      fat_g: mealRollup.today.fatG,
    },
    nutrition_assumption: nutritionAssumption,
    tonight_sleep_target: sleepTarget,
    data_freshness: {
      is_stale: (recoveryFreshnessHours ?? 99) > 18 || (sleepFreshnessHours ?? 99) > 18,
      recovery_hours: recoveryFreshnessHours,
      sleep_hours: sleepFreshnessHours,
    },
    pending_health_insights: pendingInsights,
    surfaced_insight_ids: surfacedInsightIds,
    insight_mark_sql: markInsightsSql(surfacedInsightIds),
    hydration_signal: {
      liters: hydration.liters,
      source: hydration.source,
      status: hydrationStatus,
    },
    proactive_warning: overreachWarning
      ? (lateCaffeine
          ? "Late caffeine detected — cut caffeine now and protect sleep window tonight."
          : highCaffeine
            ? "High caffeine load detected — no more caffeine today and prioritize wind-down."
            : "High strain detected — avoid additional high intensity until next recovery check.")
      : null,
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
    coach_nutrition_log: {
      table: "coach_nutrition_log",
      status: nutritionWrite.ok ? "ok" : "error",
      error: nutritionWrite.ok ? null : nutritionWrite.error ?? "unknown",
    },
    errors,
    quality_flags: {
      has_whoop_training: whoopSummary.whoop_workouts_today > 0,
      has_tonal_training: todayWorkouts.length > 0,
      has_meal_logs: mealEntries.length > 0,
    },
    tonal_health: tonalHealth,
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
