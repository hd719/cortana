#!/usr/bin/env npx tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AthleteStateDailyRow } from "./athlete-state-db.js";
import { fetchAthleteStateRow } from "./athlete-state-db.js";
import { localYmd } from "./signal-utils.js";
import { buildTonalSessionPlanFromPayload } from "./tonal-session-planner.js";
import {
  type TrainingStateWeeklyRow,
  fetchLatestTrainingStateWeekly,
  upsertRecommendationLog,
} from "./training-intelligence-db.js";
import {
  linkPlannerSessionToRecommendation,
  upsertPlannedSession,
  upsertProgramTemplates,
  upsertTonalLibrarySnapshot,
  type PlannedSessionInput,
} from "./tonal-plan-db.js";
import { DEFAULT_TONAL_PROGRAM_TEMPLATES } from "./tonal-template-library.js";

export type TonalPlanArtifact = {
  schema: "spartan.tonal_plan.v1";
  generated_at: string;
  date_local: string;
  plan: PlannedSessionInput;
  library_snapshot: {
    workouts_seen: number;
    movements_seen: number;
    mapped_movement_pct: number;
    latest_workout_at: string | null;
  };
};

function curlJson(url: string, timeoutSec: number): unknown {
  const result = spawnSync("curl", ["-s", "--max-time", String(timeoutSec), url], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if ((result.status ?? 1) !== 0) return {};
  try {
    return JSON.parse((result.stdout ?? "").trim() || "{}");
  } catch {
    return {};
  }
}

function addDays(dateYmd: string, days: number): string {
  const date = new Date(`${dateYmd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function tonalPlanPaths(dateLocal: string, agentId = "cron-fitness"): {
  sandboxJsonPath: string;
  sandboxMarkdownPath: string;
  repoJsonPath: string;
  repoMarkdownPath: string;
  repoCatalogPath: string;
};
export function tonalPlanPaths(
  dateLocal: string,
  agentId = "cron-fitness",
  roots?: {
    sandboxRoot?: string;
    repoRoot?: string;
    programRoot?: string;
  },
): {
  sandboxJsonPath: string;
  sandboxMarkdownPath: string;
  repoJsonPath: string;
  repoMarkdownPath: string;
  repoCatalogPath: string;
} {
  const sandboxRoot = roots?.sandboxRoot ?? path.join(os.homedir(), ".openclaw", "workspaces", agentId, "memory", "fitness", "plans");
  const repoRoot = roots?.repoRoot ?? path.join("/Users/hd/Developer/cortana/memory/fitness/plans");
  return {
    sandboxJsonPath: path.join(sandboxRoot, `${dateLocal}-tomorrow-session.json`),
    sandboxMarkdownPath: path.join(sandboxRoot, `${dateLocal}-tomorrow-session.md`),
    repoJsonPath: path.join(repoRoot, `${dateLocal}-tomorrow-session.json`),
    repoMarkdownPath: path.join(repoRoot, `${dateLocal}-tomorrow-session.md`),
    repoCatalogPath: path.join(roots?.programRoot ?? "/Users/hd/Developer/cortana/memory/fitness/programs/json", "current-tonal-catalog.json"),
  };
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function renderTonalPlanMarkdown(artifact: TonalPlanArtifact): string {
  const blocks = Array.isArray((artifact.plan.sessionBlocks as { blocks?: unknown[] } | undefined)?.blocks)
    ? (((artifact.plan.sessionBlocks as { blocks?: unknown[] }).blocks ?? []) as Array<{ label: string; plannedMovements: Array<{ label: string; movementTitle: string | null; setTarget: number; repRange: [number, number] }> }>)
    : [];
  const lines = [
    "# Spartan Tonal Plan",
    "",
    `- Date: ${artifact.date_local}`,
    `- Plan type: ${artifact.plan.planType}`,
    `- Template: ${artifact.plan.sourceTemplateId}`,
    `- Confidence: ${artifact.plan.confidence}`,
    `- Duration: ${artifact.plan.targetDurationMinutes}m`,
    "",
    "## Constraints",
    "",
    ...Object.entries(artifact.plan.constraints).map(([key, value]) => `- ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`),
    "",
    "## Session Blocks",
    "",
    ...blocks.flatMap((block) => [
      `### ${block.label}`,
      ...block.plannedMovements.map((movement) => `- ${movement.label}: ${movement.movementTitle ?? "manual slot"} (${movement.setTarget} sets, ${movement.repRange[0]}-${movement.repRange[1]} reps)`),
      "",
    ]),
    "## Rationale",
    "",
    ...Object.entries(artifact.plan.rationale).map(([key, value]) => `- ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`),
    "",
  ];
  return `${lines.join("\n").trim()}\n`;
}

export function buildTonalPlanArtifact(input: {
  dateLocal: string;
  plan: PlannedSessionInput;
  librarySummary: TonalPlanArtifact["library_snapshot"];
}): TonalPlanArtifact {
  return {
    schema: "spartan.tonal_plan.v1",
    generated_at: new Date().toISOString(),
    date_local: input.dateLocal,
    plan: input.plan,
    library_snapshot: input.librarySummary,
  };
}

export function persistTonalPlanArtifact(
  artifact: TonalPlanArtifact,
  catalog: Record<string, unknown>,
  options?: {
    agentId?: string;
    sandboxRoot?: string;
    repoRoot?: string;
    programRoot?: string;
  },
): {
  ok: boolean;
  repoJsonPath: string;
  repoMarkdownPath: string;
  repoCatalogPath: string;
} {
  const paths = tonalPlanPaths(artifact.date_local, options?.agentId, options);
  for (const filePath of [paths.sandboxJsonPath, paths.sandboxMarkdownPath, paths.repoJsonPath, paths.repoMarkdownPath, paths.repoCatalogPath]) {
    ensureDir(filePath);
  }
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  const markdown = renderTonalPlanMarkdown(artifact);
  const catalogJson = `${JSON.stringify(catalog, null, 2)}\n`;
  fs.writeFileSync(paths.sandboxJsonPath, json, "utf8");
  fs.writeFileSync(paths.sandboxMarkdownPath, markdown, "utf8");
  fs.writeFileSync(paths.repoJsonPath, json, "utf8");
  fs.writeFileSync(paths.repoMarkdownPath, markdown, "utf8");
  fs.writeFileSync(paths.repoCatalogPath, catalogJson, "utf8");
  return {
    ok: true,
    repoJsonPath: paths.repoJsonPath,
    repoMarkdownPath: paths.repoMarkdownPath,
    repoCatalogPath: paths.repoCatalogPath,
  };
}

export function buildAndPersistTomorrowTonalPlan(input: {
  today?: string;
  tonalPayload: unknown;
  agentId?: string;
  athleteState?: AthleteStateDailyRow | null;
  weeklyTrainingState?: TrainingStateWeeklyRow | null;
}): {
  artifact: TonalPlanArtifact;
  planWrite: ReturnType<typeof upsertPlannedSession>;
  snapshotWrite: ReturnType<typeof upsertTonalLibrarySnapshot>;
  recommendationWrite: ReturnType<typeof upsertRecommendationLog>;
  artifactWrite: ReturnType<typeof persistTonalPlanArtifact>;
} {
  const today = input.today ?? localYmd();
  const targetDate = addDays(today, 1);
  const athleteState = input.athleteState === undefined ? fetchAthleteStateRow(today) : input.athleteState;
  const weeklyTrainingState = input.weeklyTrainingState === undefined ? fetchLatestTrainingStateWeekly() : input.weeklyTrainingState;
  const { catalog, plan } = buildTonalSessionPlanFromPayload({
    tonalPayload: input.tonalPayload,
    athleteState,
    weeklyTrainingState,
    targetDate,
    templates: DEFAULT_TONAL_PROGRAM_TEMPLATES,
  });

  upsertProgramTemplates(DEFAULT_TONAL_PROGRAM_TEMPLATES);
  const snapshotWrite = upsertTonalLibrarySnapshot({
    snapshotDate: today,
    generatedAt: new Date().toISOString(),
    userId: catalog.userId,
    workoutsSeen: catalog.summary.workoutsSeen,
    movementsSeen: catalog.summary.movementsSeen,
    strengthScoresPresent: catalog.summary.strengthScoresPresent,
    programSummary: {
      count: catalog.programs.length,
      dominant_focus: catalog.programs[0]?.dominantFocus ?? "unknown",
      program_ids: catalog.programs.slice(0, 10).map((program) => program.programId),
    },
    movementSummary: {
      mapped_movement_pct: catalog.summary.mappedMovementPct,
      top_movements: catalog.movements.slice(0, 12).map((movement) => movement.canonicalKey),
    },
    qualityFlags: catalog.qualityFlags,
    raw: catalog.raw,
  });

  const plannedSession: PlannedSessionInput = {
    stateDate: targetDate,
    isoWeek: weeklyTrainingState?.iso_week ?? null,
    planType: plan.planType,
    sourceTemplateId: plan.sourceTemplateId,
    confidence: plan.confidence,
    targetDurationMinutes: plan.targetDurationMinutes,
    targetMuscles: plan.targetMuscles,
    sessionBlocks: { blocks: plan.sessionBlocks },
    constraints: plan.constraints,
    rationale: plan.rationale,
    artifactPath: tonalPlanPaths(today, input.agentId).repoMarkdownPath,
  };
  const planWrite = upsertPlannedSession(plannedSession);
  const plannerSessionId = planWrite.row?.id ?? null;
  const recommendationWrite = upsertRecommendationLog({
    recommendationKey: `spartan:planner:${targetDate}`,
    recommendationScope: "daily",
    stateDate: targetDate,
    isoWeek: weeklyTrainingState?.iso_week ?? null,
    mode: plan.planType,
    confidence: plan.confidence,
    rationale: JSON.stringify(plan.rationale),
    inputs: plan.constraints,
    outputs: {
      template_id: plan.sourceTemplateId,
      duration_minutes: plan.targetDurationMinutes,
      target_muscles: plan.targetMuscles,
    },
  });
  if (plannerSessionId) {
    linkPlannerSessionToRecommendation(`spartan:planner:${targetDate}`, plannerSessionId, plan.plannerContext);
  }
  const artifact = buildTonalPlanArtifact({
    dateLocal: today,
    plan: {
      ...plannedSession,
      id: plannerSessionId ?? undefined,
    },
    librarySummary: {
      workouts_seen: catalog.summary.workoutsSeen,
      movements_seen: catalog.summary.movementsSeen,
      mapped_movement_pct: catalog.summary.mappedMovementPct,
      latest_workout_at: catalog.summary.latestWorkoutAt,
    },
  });
  const artifactWrite = persistTonalPlanArtifact(artifact, catalog as unknown as Record<string, unknown>, { agentId: input.agentId });
  return {
    artifact,
    planWrite,
    snapshotWrite,
    recommendationWrite,
    artifactWrite,
  };
}

function main(): void {
  const today = process.argv[2] || localYmd();
  const tonal = curlJson("http://127.0.0.1:3033/tonal/data?fresh=true", 20);
  const result = buildAndPersistTomorrowTonalPlan({
    today,
    tonalPayload: tonal,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
