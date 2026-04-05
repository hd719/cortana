import type { AthleteStateDailyRow } from "./athlete-state-db.js";
import type { TrainingStateWeeklyRow } from "./training-intelligence-db.js";
import {
  buildTonalProgramCatalog,
  catalogMovementCandidatesForSlot,
  type TonalPlannerFocus,
  type TonalProgramCatalog,
} from "./tonal-program-catalog.js";
import {
  DEFAULT_TONAL_PROGRAM_TEMPLATES,
  selectTonalTemplates,
  type TonalProgramTemplate,
  type TonalTemplateGoalMode,
} from "./tonal-template-library.js";

export type TonalPlannerConstraintPack = {
  readinessBand: string | null;
  readinessConfidence: number | null;
  fatigueScore: number | null;
  interferenceRiskScore: number | null;
  availableTimeMinutes: number;
  laggingMuscles: string[];
  overdosedMuscles: string[];
  sorenessMuscles?: string[];
  phaseMode: string | null;
  weeklyRecommendationMode: string | null;
};

export type TonalPlannedMovement = {
  slotId: string;
  label: string;
  targetMuscles: string[];
  preferredPatterns: string[];
  setTarget: number;
  repRange: [number, number];
  movementId: string | null;
  movementTitle: string | null;
  confidence: number;
  rationale: string;
};

export type TonalSessionPlan = {
  planType: "tomorrow" | "next_week" | "recovery_fallback" | "travel_fallback";
  sourceTemplateId: string;
  confidence: number;
  targetDurationMinutes: number;
  targetMuscles: Record<string, unknown>;
  sessionBlocks: Array<{
    blockId: string;
    label: string;
    goal: string;
    plannedMovements: TonalPlannedMovement[];
  }>;
  constraints: Record<string, unknown>;
  rationale: Record<string, unknown>;
  plannerContext: Record<string, unknown>;
};

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function majorBucket(muscle: string): "upper" | "lower" | "other" {
  if (["chest", "back", "lats", "shoulders", "rear_delts", "biceps", "triceps"].includes(muscle)) return "upper";
  if (["quads", "hamstrings", "glutes", "calves"].includes(muscle)) return "lower";
  return "other";
}

function countByBucket(muscles: string[]): { upper: number; lower: number } {
  return muscles.reduce(
    (acc, muscle) => {
      const bucket = majorBucket(muscle);
      if (bucket === "upper") acc.upper += 1;
      if (bucket === "lower") acc.lower += 1;
      return acc;
    },
    { upper: 0, lower: 0 },
  );
}

function goalModeFromContext(input: {
  phaseMode: string | null;
  weeklyRecommendationMode: string | null;
  readinessBand: string | null;
  fatigueScore: number | null;
}): TonalTemplateGoalMode {
  if (input.readinessBand === "red" || (input.fatigueScore ?? 0) >= 18) return "recovery";
  if (input.phaseMode?.includes("cut")) return "cut_support";
  if (input.weeklyRecommendationMode === "deload") return "recovery";
  if (input.weeklyRecommendationMode === "volume_hold") return "maintenance";
  return "hypertrophy";
}

function preferredFocus(input: TonalPlannerConstraintPack): TonalPlannerFocus {
  if (input.readinessBand === "red" || (input.fatigueScore ?? 0) >= 18) return "recovery";
  if (input.availableTimeMinutes <= 30) return "full_body";
  const lagging = countByBucket(input.laggingMuscles);
  const overdosed = countByBucket(input.overdosedMuscles);
  const lowerPenalty = (input.interferenceRiskScore ?? 0) >= 45 || overdosed.lower > lagging.lower;
  if (lagging.upper > 0 && (lagging.upper >= lagging.lower || lowerPenalty)) return "upper";
  if (lagging.lower > 0 && !lowerPenalty) return "lower";
  if ((input.weeklyRecommendationMode ?? "") === "volume_fall") return lowerPenalty ? "upper" : "full_body";
  return input.availableTimeMinutes <= 35 ? "full_body" : "push";
}

function focusTagsForContext(focus: TonalPlannerFocus): string[] {
  if (focus === "upper") return ["upper_emphasis"];
  if (focus === "lower") return ["lower_emphasis"];
  if (focus === "push") return ["push_bias"];
  if (focus === "pull") return ["pull_bias"];
  if (focus === "full_body") return ["full_body"];
  if (focus === "recovery") return ["low_fatigue"];
  return [];
}

function latestRecentFocus(catalog: TonalProgramCatalog): TonalPlannerFocus | null {
  return catalog.recentWorkouts[0]?.focus ?? null;
}

function planTypeForContext(input: TonalPlannerConstraintPack): TonalSessionPlan["planType"] {
  if (input.readinessBand === "red" || (input.fatigueScore ?? 0) >= 18) return "recovery_fallback";
  if (input.availableTimeMinutes < 25) return "travel_fallback";
  return "tomorrow";
}

function chooseTemplate(input: {
  catalog: TonalProgramCatalog;
  constraints: TonalPlannerConstraintPack;
  templates?: TonalProgramTemplate[];
}): { template: TonalProgramTemplate; goalMode: TonalTemplateGoalMode; focus: TonalPlannerFocus; rationale: string[] } {
  const goalMode = goalModeFromContext(input.constraints);
  const focus = preferredFocus(input.constraints);
  const rationale = [
    `Goal mode resolved to ${goalMode}.`,
    `Preferred session focus resolved to ${focus}.`,
  ];
  if ((input.constraints.interferenceRiskScore ?? 0) >= 45) rationale.push("Cardio interference is elevated, so lower-body fatigue is constrained.");
  const lastFocus = latestRecentFocus(input.catalog);
  if (lastFocus && lastFocus === focus && focus !== "recovery" && focus !== "full_body") rationale.push(`Recent Tonal focus was also ${focus}, so confidence is reduced slightly.`);
  const templates = selectTonalTemplates({
    templates: input.templates ?? DEFAULT_TONAL_PROGRAM_TEMPLATES,
    goalMode,
    availableTimeMinutes: input.constraints.availableTimeMinutes,
    preferredTags: focusTagsForContext(focus),
    weeklyRecommendationMode: input.constraints.weeklyRecommendationMode ?? null,
    readinessBand: input.constraints.readinessBand ?? null,
  });
  return {
    template: templates[0] ?? DEFAULT_TONAL_PROGRAM_TEMPLATES[0],
    goalMode,
    focus,
    rationale,
  };
}

function blockRationale(muscles: string[], patterns: string[], movementTitle: string | null): string {
  if (movementTitle) {
    return `Selected ${movementTitle} because it matches ${muscles.join("/")} with ${patterns.join("/")} coverage.`;
  }
  return `No confident Tonal movement candidate matched ${muscles.join("/")} with ${patterns.join("/")}; keep this slot manual.`;
}

function buildPlanBlocks(input: {
  catalog: TonalProgramCatalog;
  template: TonalProgramTemplate;
  laggingMuscles: string[];
}): TonalSessionPlan["sessionBlocks"] {
  const usedMovementIds = new Set<string>();
  return input.template.templateBody.blocks.map((block) => ({
    blockId: block.blockId,
    label: block.label,
    goal: block.goal,
    plannedMovements: block.slots.map((slot) => {
      const candidates = catalogMovementCandidatesForSlot({
        catalog: input.catalog,
        targetMuscles: slot.targetMuscles,
        preferredPatterns: slot.preferredPatterns,
        excludeMovementIds: [...usedMovementIds],
        limit: 3,
      });
      const chosen = candidates[0] ?? null;
      if (chosen?.movementId) usedMovementIds.add(chosen.movementId);
      const laggingBonus = slot.targetMuscles.some((muscle) => input.laggingMuscles.includes(muscle)) ? 0.06 : 0;
      return {
        slotId: slot.slotId,
        label: slot.label,
        targetMuscles: slot.targetMuscles,
        preferredPatterns: slot.preferredPatterns,
        setTarget: slot.setTarget,
        repRange: slot.repRange,
        movementId: chosen?.movementId ?? null,
        movementTitle: chosen?.sampleTitle ?? chosen?.canonicalKey ?? null,
        confidence: round(Math.min(0.98, (chosen?.confidence ?? 0.3) + laggingBonus)),
        rationale: blockRationale(slot.targetMuscles, slot.preferredPatterns, chosen?.sampleTitle ?? chosen?.canonicalKey ?? null),
      } satisfies TonalPlannedMovement;
    }),
  }));
}

function buildConfidence(input: {
  template: TonalProgramTemplate;
  blocks: TonalSessionPlan["sessionBlocks"];
  constraints: TonalPlannerConstraintPack;
  weeklyConfidence: number | null;
  catalog: TonalProgramCatalog;
}): number {
  const movementCoverage = input.blocks.flatMap((block) => block.plannedMovements).filter((movement) => movement.movementId).length;
  const totalMovements = input.blocks.flatMap((block) => block.plannedMovements).length || 1;
  const coverage = movementCoverage / totalMovements;
  let score =
    (input.weeklyConfidence ?? 0.45) * 0.45
    + coverage * 0.25
    + (input.catalog.summary.mappedMovementPct / 100) * 0.18
    + (input.constraints.readinessBand === "green" ? 0.08 : input.constraints.readinessBand === "yellow" ? 0.04 : 0);
  if (input.constraints.readinessBand === "red") score -= 0.18;
  if ((input.constraints.interferenceRiskScore ?? 0) >= 45 && input.template.tags.includes("lower_emphasis")) score -= 0.08;
  if ((input.constraints.fatigueScore ?? 0) >= 18) score -= 0.08;
  return round(Math.max(0.22, Math.min(0.97, score)));
}

export function buildTonalSessionPlan(input: {
  catalog: TonalProgramCatalog;
  athleteState: AthleteStateDailyRow | null;
  weeklyTrainingState: TrainingStateWeeklyRow | null;
  targetDate: string;
  availableTimeMinutes?: number;
  templates?: TonalProgramTemplate[];
}): TonalSessionPlan {
  const weekly = input.weeklyTrainingState;
  const constraints: TonalPlannerConstraintPack = {
    readinessBand: input.athleteState?.readiness_band ?? null,
    readinessConfidence: input.athleteState?.readiness_confidence ?? null,
    fatigueScore: weekly?.fatigue_score ?? input.athleteState?.fatigue_debt ?? null,
    interferenceRiskScore: weekly?.interference_risk_score ?? null,
    availableTimeMinutes: input.availableTimeMinutes ?? 45,
    laggingMuscles: Object.keys(weekly?.underdosed_muscles ?? {}),
    overdosedMuscles: Object.keys(weekly?.overdosed_muscles ?? {}),
    sorenessMuscles: [],
    phaseMode: input.athleteState?.phase_mode ?? weekly?.phase_mode ?? null,
    weeklyRecommendationMode: String(weekly?.recommendation_summary?.mode ?? ""),
  };
  const choice = chooseTemplate({
    catalog: input.catalog,
    constraints,
    templates: input.templates,
  });
  const blocks = buildPlanBlocks({
    catalog: input.catalog,
    template: choice.template,
    laggingMuscles: constraints.laggingMuscles,
  });
  const confidence = buildConfidence({
    template: choice.template,
    blocks,
    constraints,
    weeklyConfidence: weekly?.confidence ?? null,
    catalog: input.catalog,
  });
  return {
    planType: planTypeForContext(constraints),
    sourceTemplateId: choice.template.templateId,
    confidence,
    targetDurationMinutes: choice.template.durationMinutes,
    targetMuscles: {
      lagging: constraints.laggingMuscles,
      overloaded: constraints.overdosedMuscles,
      template_focus: choice.template.templateBody.focus,
    },
    sessionBlocks: blocks,
    constraints: {
      readiness_band: constraints.readinessBand,
      readiness_confidence: constraints.readinessConfidence,
      fatigue_score: constraints.fatigueScore,
      interference_risk_score: constraints.interferenceRiskScore,
      available_time_minutes: constraints.availableTimeMinutes,
      phase_mode: constraints.phaseMode,
    },
    rationale: {
      planner_goal_mode: choice.goalMode,
      preferred_focus: choice.focus,
      reasons: choice.rationale,
      recent_focus: latestRecentFocus(input.catalog),
      weekly_recommendation_mode: constraints.weeklyRecommendationMode,
    },
    plannerContext: {
      target_date: input.targetDate,
      template_tags: choice.template.tags,
      template_version: choice.template.version,
      catalog_workouts_seen: input.catalog.summary.workoutsSeen,
      catalog_movements_seen: input.catalog.summary.movementsSeen,
      mapped_movement_pct: input.catalog.summary.mappedMovementPct,
    },
  };
}

export function buildTonalSessionPlanFromPayload(input: {
  tonalPayload: unknown;
  athleteState: AthleteStateDailyRow | null;
  weeklyTrainingState: TrainingStateWeeklyRow | null;
  targetDate: string;
  availableTimeMinutes?: number;
  templates?: TonalProgramTemplate[];
}): { catalog: TonalProgramCatalog; plan: TonalSessionPlan } {
  const catalog = buildTonalProgramCatalog(input.tonalPayload);
  const plan = buildTonalSessionPlan({
    catalog,
    athleteState: input.athleteState,
    weeklyTrainingState: input.weeklyTrainingState,
    targetDate: input.targetDate,
    availableTimeMinutes: input.availableTimeMinutes,
    templates: input.templates,
  });
  return { catalog, plan };
}
