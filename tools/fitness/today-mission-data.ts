import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMorningTrainingRecommendation, readinessEmoji, whoopRecoveryBandFromScore } from "./coaching-rules.js";
import { buildNutritionAssumption, type NutritionAssumption } from "./evening-recap-data.js";
import type { ReliabilityGuardrailStatus } from "./reliability-guardrail.js";
import { buildWeeklyProteinAssumption, type WeeklyProteinAssumption } from "./weekly-insights-data.js";
import type { ReadinessBand } from "./signal-utils.js";

type TrainingRecommendation = ReturnType<typeof buildMorningTrainingRecommendation>;

type HydrationStatus = "unknown" | "low" | "moderate" | "on_track";

export type TodayMissionInput = {
  dateLocal: string;
  readinessScore: number | null;
  sleepPerformance: number | null;
  hrvLatest?: number | null;
  rhrLatest?: number | null;
  recoveryFreshnessHours?: number | null;
  sleepFreshnessHours?: number | null;
  whoopStrainToday: number | null;
  tonalSessionsToday: number;
  tonalVolumeToday: number | null;
  stepCountToday: number | null;
  mealsLoggedToday: number;
  proteinActualGToday: number | null;
  proteinStatusToday: "below" | "on_target" | "above" | "unknown";
  proteinTargetG?: number;
  hydrationStatusToday?: HydrationStatus;
  weeklyProteinDaysLogged?: number;
  weeklyProteinDaysOnTarget?: number;
  weeklyProteinDaysLoggedPrior?: number;
  weeklyProteinAvgDaily?: number | null;
  trainingOverride?: {
    mode: TrainingRecommendation["mode"];
    rationale: string;
    concrete_action: string;
  } | null;
  guardrailStatus?: ReliabilityGuardrailStatus;
  guardrailSummary?: string | null;
};

export type TodayMissionArtifact = {
  schema: "spartan.today_mission.v1";
  generated_at: string;
  date_local: string;
  mission_key: string;
  readiness: {
    score: number | null;
    band: ReadinessBand;
    emoji: string;
    freshness_hours: {
      recovery: number | null;
      sleep: number | null;
      stale: boolean;
    };
  };
  training: {
    mode: TrainingRecommendation["mode"];
    rationale: string;
    concrete_action: string;
    whoop_strain_today: number | null;
    tonal_sessions_today: number;
    tonal_volume_today: number | null;
    step_count_today: number | null;
  };
  nutrition: NutritionAssumption & {
    protein_target_g: number;
    protein_actual_g: number | null;
    meals_logged_today: number;
    hydration_status: HydrationStatus;
  };
  weekly_fueling: WeeklyProteinAssumption & {
    days_logged: number;
    days_on_target: number;
    avg_daily_g: number | null;
  };
  sleep_target: {
    min_hours: number;
    goal_hours: number;
    lights_out_local: string;
    reason: string;
    concrete_action: string;
  };
  priorities: string[];
  non_negotiables: string[];
  top_risk: string;
  confidence: "high" | "medium" | "low";
  summary: string;
};

export function todayMissionPaths(dateLocal: string, agentId = "cron-fitness"): {
  sandboxFilePath: string;
  repoFilePath: string;
} {
  return {
    sandboxFilePath: path.join(os.homedir(), ".openclaw", "workspaces", agentId, "memory", "fitness", "daily", `${dateLocal}.json`),
    repoFilePath: path.join("/Users/hd/Developer/cortana/memory/fitness/daily", `${dateLocal}.json`),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number | null | undefined, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sleepTarget(opts: {
  strain: number | null;
  tonalSessions: number;
  proteinStatus: "below" | "on_target" | "above" | "unknown";
}): TodayMissionArtifact["sleep_target"] {
  let goalHours = 7.5;
  if ((opts.strain ?? 0) >= 14 || opts.tonalSessions >= 2) goalHours = 8;
  if ((opts.strain ?? 0) >= 18) goalHours = 8.25;
  if (opts.proteinStatus === "below") goalHours += 0.25;

  const cappedGoal = Number(clamp(goalHours, 7.5, 8.5).toFixed(2));
  return {
    min_hours: 7.5,
    goal_hours: cappedGoal,
    lights_out_local: "22:15",
    reason: "Sleep protects adaptation and reduces the chance of carrying fatigue into tomorrow.",
    concrete_action: `Set lights-out for 10:15 PM ET and protect a ${cappedGoal}h sleep window.`,
  };
}

function buildTopRisk(opts: {
  stale: boolean;
  readinessBand: ReadinessBand;
  sleepPerformance: number | null;
  nutrition: NutritionAssumption;
  strain: number | null;
  tonalSessions: number;
}): string {
  if (opts.stale) return "Acting on stale recovery data could turn today into a guess instead of a controlled training decision.";
  if (opts.readinessBand === "red") return "Hard training on a red readiness day will compound fatigue.";
  if ((opts.strain ?? 0) >= 16 || opts.tonalSessions >= 2) return "Accumulated training load is high enough that execution quality matters more than volume.";
  if (opts.nutrition.status !== "observed_from_logs") return "Under-fueling risk is unresolved until protein intake is logged.";
  if ((opts.sleepPerformance ?? 100) < 80) return "Sleep debt is still dragging adaptation.";
  return "Avoid turning a decent day into junk volume.";
}

function buildConfidence(opts: {
  stale: boolean;
  readinessBand: ReadinessBand;
  nutrition: NutritionAssumption;
  weeklyFueling: WeeklyProteinAssumption;
  guardrailStatus?: ReliabilityGuardrailStatus;
}): "high" | "medium" | "low" {
  if (opts.guardrailStatus === "block") return "low";
  if (opts.guardrailStatus === "warn") return "medium";
  if (opts.stale || opts.readinessBand === "unknown") return "low";
  if (opts.nutrition.confidence === "high" && opts.weeklyFueling.confidence === "high") return "high";
  return "medium";
}

export function buildTodayMissionArtifact(input: TodayMissionInput): TodayMissionArtifact {
  const readinessBand = whoopRecoveryBandFromScore(input.readinessScore);
  const stale = (input.recoveryFreshnessHours ?? 99) > 18 || (input.sleepFreshnessHours ?? 99) > 18;
  const recommendation = input.trainingOverride ?? buildMorningTrainingRecommendation({
    readinessBand,
    sleepPerformance: input.sleepPerformance,
    isStale: stale,
  });
  const nutrition = buildNutritionAssumption({
    mealsLogged: input.mealsLoggedToday,
    proteinStatus: input.proteinStatusToday,
    totalStrainToday: input.whoopStrainToday ?? 0,
    tonalSessions: input.tonalSessionsToday,
  });
  const weeklyFueling = buildWeeklyProteinAssumption({
    currentDaysLogged: input.weeklyProteinDaysLogged ?? 0,
    previousDaysLogged: input.weeklyProteinDaysLoggedPrior ?? 0,
    currentAvgProtein: input.weeklyProteinAvgDaily ?? null,
  });
  const sleep = sleepTarget({
    strain: input.whoopStrainToday,
    tonalSessions: input.tonalSessionsToday,
    proteinStatus: input.proteinStatusToday,
  });
  const topRisk = buildTopRisk({
    stale,
    readinessBand,
    sleepPerformance: input.sleepPerformance,
    nutrition,
    strain: input.whoopStrainToday,
    tonalSessions: input.tonalSessionsToday,
  });
  const topRiskWithGuardrail = input.guardrailStatus && input.guardrailStatus !== "ok" && input.guardrailSummary
    ? input.guardrailSummary
    : topRisk;

  const priorities = [
    recommendation.concrete_action,
    nutrition.coaching_note,
    sleep.concrete_action,
  ];

  const nonNegotiables = [
    `Protein target: ${input.proteinTargetG ?? 120}g today`,
    `Sleep window: ${sleep.goal_hours}h minimum`,
    `Training rule: ${recommendation.mode.replace(/_/g, " ")}`,
  ];

  const weeklySummary = weeklyFueling.status === "observed_from_logs"
    ? "weekly fueling is being observed"
    : "weekly fueling still needs consistent logs";

  const summary = `${readinessEmoji(readinessBand)} ${readinessBand.toUpperCase()} | ${recommendation.mode} | ${weeklySummary}`;

  return {
    schema: "spartan.today_mission.v1",
    generated_at: new Date().toISOString(),
    date_local: input.dateLocal,
    mission_key: `spartan:${input.dateLocal}:${readinessBand}:${recommendation.mode}`,
    readiness: {
      score: input.readinessScore,
      band: readinessBand,
      emoji: readinessEmoji(readinessBand),
      freshness_hours: {
        recovery: round(input.recoveryFreshnessHours ?? null),
        sleep: round(input.sleepFreshnessHours ?? null),
        stale,
      },
    },
    training: {
      mode: recommendation.mode,
      rationale: recommendation.rationale,
      concrete_action: recommendation.concrete_action,
      whoop_strain_today: round(input.whoopStrainToday),
      tonal_sessions_today: input.tonalSessionsToday,
      tonal_volume_today: round(input.tonalVolumeToday),
      step_count_today: input.stepCountToday == null ? null : Math.round(input.stepCountToday),
    },
    nutrition: {
      ...nutrition,
      protein_target_g: input.proteinTargetG ?? 120,
      protein_actual_g: input.proteinActualGToday == null ? null : Math.round(input.proteinActualGToday),
      meals_logged_today: input.mealsLoggedToday,
      hydration_status: input.hydrationStatusToday ?? "unknown",
    },
    weekly_fueling: {
      ...weeklyFueling,
      days_logged: input.weeklyProteinDaysLogged ?? 0,
      days_on_target: input.weeklyProteinDaysOnTarget ?? 0,
      avg_daily_g: round(input.weeklyProteinAvgDaily ?? null),
    },
    sleep_target: sleep,
    priorities,
    non_negotiables: nonNegotiables,
    top_risk: topRiskWithGuardrail,
    confidence: buildConfidence({
      stale,
      readinessBand,
      nutrition,
      weeklyFueling,
      guardrailStatus: input.guardrailStatus,
    }),
    summary,
  };
}

export function persistTodayMissionArtifact(
  artifact: TodayMissionArtifact,
  options?: { agentId?: string },
): {
  ok: boolean;
  sandboxFilePath: string;
  repoFilePath: string;
  sandboxWrite: "ok" | "error";
  repoMirrorWrite: "ok" | "error";
  errors: string[];
} {
  const paths = todayMissionPaths(artifact.date_local, options?.agentId);
  const payload = `${JSON.stringify(artifact, null, 2)}\n`;
  const errors: string[] = [];
  let sandboxWrite: "ok" | "error" = "ok";
  let repoMirrorWrite: "ok" | "error" = "ok";

  try {
    fs.mkdirSync(path.dirname(paths.sandboxFilePath), { recursive: true });
    fs.writeFileSync(paths.sandboxFilePath, payload, "utf8");
  } catch (error) {
    sandboxWrite = "error";
    errors.push(`sandbox_write_failed:${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    fs.mkdirSync(path.dirname(paths.repoFilePath), { recursive: true });
    fs.writeFileSync(paths.repoFilePath, payload, "utf8");
  } catch (error) {
    repoMirrorWrite = "error";
    errors.push(`repo_mirror_write_failed:${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    ok: errors.length === 0,
    sandboxFilePath: paths.sandboxFilePath,
    repoFilePath: paths.repoFilePath,
    sandboxWrite,
    repoMirrorWrite,
    errors,
  };
}
