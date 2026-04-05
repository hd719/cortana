import {
  extractTonalSetActivities,
  tonalWorkoutsFromPayload,
  type TonalSetActivity,
} from "./signal-utils.js";

type PlannerMuscleGroup = Exclude<TonalSetActivity["muscleGroup"], "unmapped">;
export type TonalPlannerFocus = "upper" | "lower" | "push" | "pull" | "full_body" | "recovery" | "mixed" | "unknown";

export type TonalCatalogMovement = {
  movementId: string;
  canonicalKey: string;
  sampleTitle: string | null;
  muscleGroup: TonalSetActivity["muscleGroup"];
  pattern: TonalSetActivity["pattern"];
  mapped: boolean;
  confidence: number;
  setCount: number;
  workoutCount: number;
  lastSeenAt: string | null;
  avgLoad: number | null;
  avgReps: number | null;
  avgVolume: number | null;
};

export type TonalCatalogWorkout = {
  workoutId: string;
  programId: string | null;
  workoutType: string | null;
  occurrences: number;
  latestAt: string | null;
  avgDurationMinutes: number | null;
  avgVolume: number | null;
  movementIds: string[];
  dominantMuscles: string[];
  focus: TonalPlannerFocus;
  qualityFlags: string[];
};

export type TonalCatalogProgram = {
  programId: string;
  enrollmentIds: string[];
  workoutIds: string[];
  occurrences: number;
  latestAt: string | null;
  dominantFocus: TonalPlannerFocus;
  dominantMuscles: string[];
};

export type TonalCatalogSummary = {
  workoutsSeen: number;
  movementsSeen: number;
  mappedMovementPct: number;
  strengthScoresPresent: boolean;
  latestWorkoutAt: string | null;
};

export type TonalProgramCatalog = {
  userId: string | null;
  generatedAt: string;
  summary: TonalCatalogSummary;
  recentWorkouts: Array<{
    activityId: string;
    workoutId: string | null;
    programId: string | null;
    beginTime: string | null;
    durationMinutes: number | null;
    totalVolume: number | null;
    focus: TonalPlannerFocus;
    dominantMuscles: string[];
    mappedMovementPct: number;
  }>;
  workouts: TonalCatalogWorkout[];
  programs: TonalCatalogProgram[];
  movements: TonalCatalogMovement[];
  qualityFlags: Record<string, unknown>;
  raw: Record<string, unknown>;
};

function toObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: Array<number | null>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!nums.length) return null;
  return round(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function sortObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectKeys(item)) as T;
  }
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortObjectKeys((value as Record<string, unknown>)[key]);
      return acc;
    }, {}) as T;
}

function majorMuscleBucket(muscleGroup: TonalSetActivity["muscleGroup"]): "upper" | "lower" | "core" | "other" {
  if (["chest", "back", "lats", "shoulders", "rear_delts", "biceps", "triceps"].includes(muscleGroup)) return "upper";
  if (["quads", "hamstrings", "glutes", "calves"].includes(muscleGroup)) return "lower";
  if (muscleGroup === "core") return "core";
  return "other";
}

function inferFocusFromMuscles(muscles: string[]): TonalPlannerFocus {
  const upper = muscles.filter((muscle) => majorMuscleBucket(muscle as TonalSetActivity["muscleGroup"]) === "upper").length;
  const lower = muscles.filter((muscle) => majorMuscleBucket(muscle as TonalSetActivity["muscleGroup"]) === "lower").length;
  const pushing = muscles.filter((muscle) => ["chest", "shoulders", "triceps"].includes(muscle)).length;
  const pulling = muscles.filter((muscle) => ["back", "lats", "rear_delts", "biceps"].includes(muscle)).length;
  if (upper === 0 && lower === 0) return muscles.length > 0 ? "recovery" : "unknown";
  if (upper > 0 && lower > 0) return "full_body";
  if (upper > 0 && pushing >= Math.max(2, pulling + 1)) return "push";
  if (upper > 0 && pulling >= Math.max(2, pushing + 1)) return "pull";
  if (upper > 0) return "upper";
  if (lower > 0) return "lower";
  return "mixed";
}

function dominantStrings(entries: string[], limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([entry]) => entry);
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

export function buildTonalProgramCatalog(payload: unknown): TonalProgramCatalog {
  const root = toObj(payload);
  const workouts = tonalWorkoutsFromPayload(payload);
  const setActivities = extractTonalSetActivities(payload);
  const activitiesByWorkoutActivity = new Map<string, TonalSetActivity[]>();
  for (const activity of setActivities) {
    if (!activity.workoutId) continue;
    const existing = activitiesByWorkoutActivity.get(activity.workoutId) ?? [];
    existing.push(activity);
    activitiesByWorkoutActivity.set(activity.workoutId, existing);
  }

  const movementAggregates = new Map<string, TonalCatalogMovement>();
  for (const activity of setActivities) {
    const movementId = activity.movementId ?? `unmapped:${activity.movementTitle ?? activity.pattern}:${activity.muscleGroup}`;
    const existing = movementAggregates.get(movementId);
    const nextWorkoutCount = new Set([...(existing ? [String(existing.lastSeenAt ?? "")] : []), String(activity.workoutId ?? "")]).size;
    movementAggregates.set(movementId, {
      movementId,
      canonicalKey: activity.movementTitle ?? movementId,
      sampleTitle: activity.movementTitle,
      muscleGroup: activity.muscleGroup,
      pattern: activity.pattern,
      mapped: activity.mapped,
      confidence: existing ? Math.max(existing.confidence, activity.confidence) : activity.confidence,
      setCount: (existing?.setCount ?? 0) + 1,
      workoutCount: Math.max(existing?.workoutCount ?? 0, nextWorkoutCount),
      lastSeenAt: normalizedTimestamp(String(activity.raw.beginTime ?? "")) ?? existing?.lastSeenAt ?? null,
      avgLoad: average([existing?.avgLoad ?? null, activity.load]),
      avgReps: average([existing?.avgReps ?? null, activity.reps]),
      avgVolume: average([existing?.avgVolume ?? null, activity.volume]),
    });
  }

  const recentWorkouts = workouts
    .map((workout) => {
      const row = toObj(workout);
      const activityId = String(row.id ?? "");
      const workoutId = typeof row.workoutId === "string" ? row.workoutId : null;
      const programId = typeof row.programId === "string" ? row.programId : null;
      const beginTime = normalizedTimestamp(row.beginTime);
      const durationMinutes = round((toNum(row.totalDuration) ?? toNum(row.duration)) == null ? null : (toNum(row.totalDuration) ?? toNum(row.duration) ?? 0) / 60);
      const totalVolume = round(toNum(row.totalVolume));
      const workoutActivities = activitiesByWorkoutActivity.get(activityId) ?? [];
      const mappedWorkoutActivities = workoutActivities.filter((activity) => activity.mapped);
      const dominantMuscles = dominantStrings(
        mappedWorkoutActivities
          .map((activity) => activity.muscleGroup)
          .filter((muscle): muscle is PlannerMuscleGroup => muscle !== "unmapped"),
      );
      const focus = inferFocusFromMuscles(dominantMuscles);
      return {
        activityId,
        workoutId,
        programId,
        beginTime,
        durationMinutes,
        totalVolume,
        focus,
        dominantMuscles,
        mappedMovementPct: workoutActivities.length > 0 ? round((mappedWorkoutActivities.length / workoutActivities.length) * 100) ?? 0 : 0,
      };
    })
    .sort((a, b) => String(b.beginTime ?? "").localeCompare(String(a.beginTime ?? "")));

  const workoutAggregates = new Map<string, TonalCatalogWorkout>();
  for (const workout of recentWorkouts) {
    const key = workout.workoutId ?? `activity:${workout.activityId}`;
    const existing = workoutAggregates.get(key);
    const qualityFlags = existing?.qualityFlags ?? [];
    if (!workout.programId) qualityFlags.push("missing_program_id");
    if ((workout.mappedMovementPct ?? 0) < 70) qualityFlags.push("low_mapping_coverage");
    workoutAggregates.set(key, {
      workoutId: key,
      programId: workout.programId ?? existing?.programId ?? null,
      workoutType: typeof toObj(workouts.find((entry) => String(toObj(entry).id ?? "") === workout.activityId))?.workoutType === "string"
        ? String(toObj(workouts.find((entry) => String(toObj(entry).id ?? "") === workout.activityId))?.workoutType ?? "")
        : existing?.workoutType ?? null,
      occurrences: (existing?.occurrences ?? 0) + 1,
      latestAt: [existing?.latestAt, workout.beginTime].filter(Boolean).sort().at(-1) ?? null,
      avgDurationMinutes: average([existing?.avgDurationMinutes ?? null, workout.durationMinutes]),
      avgVolume: average([existing?.avgVolume ?? null, workout.totalVolume]),
      movementIds: uniqueStrings([...(existing?.movementIds ?? []), ...setActivities
        .filter((activity) => activity.workoutId === workout.activityId)
        .map((activity) => activity.movementId)]),
      dominantMuscles: dominantStrings([...(existing?.dominantMuscles ?? []), ...workout.dominantMuscles]),
      focus: workout.focus !== "unknown" ? workout.focus : existing?.focus ?? "unknown",
      qualityFlags: uniqueStrings(qualityFlags),
    });
  }

  const programAggregates = new Map<string, TonalCatalogProgram>();
  for (const workout of recentWorkouts.filter((entry) => entry.programId)) {
    const key = String(workout.programId);
    const existing = programAggregates.get(key);
    programAggregates.set(key, {
      programId: key,
      enrollmentIds: uniqueStrings([...(existing?.enrollmentIds ?? []), String(toObj(workouts.find((entry) => String(toObj(entry).id ?? "") === workout.activityId))?.programEnrollmentId ?? "")]),
      workoutIds: uniqueStrings([...(existing?.workoutIds ?? []), workout.workoutId]),
      occurrences: (existing?.occurrences ?? 0) + 1,
      latestAt: [existing?.latestAt, workout.beginTime].filter(Boolean).sort().at(-1) ?? null,
      dominantFocus: inferFocusFromMuscles([...(existing?.dominantMuscles ?? []), ...workout.dominantMuscles]),
      dominantMuscles: dominantStrings([...(existing?.dominantMuscles ?? []), ...workout.dominantMuscles]),
    });
  }

  const mappedMovements = [...movementAggregates.values()].filter((movement) => movement.mapped).length;
  const catalog: TonalProgramCatalog = {
    userId: typeof toObj(root.profile).userId === "string" ? String(toObj(root.profile).userId) : null,
    generatedAt: new Date().toISOString(),
    summary: {
      workoutsSeen: recentWorkouts.length,
      movementsSeen: movementAggregates.size,
      mappedMovementPct: movementAggregates.size > 0 ? round((mappedMovements / movementAggregates.size) * 100) ?? 0 : 0,
      strengthScoresPresent: root.strength_scores != null,
      latestWorkoutAt: recentWorkouts[0]?.beginTime ?? null,
    },
    recentWorkouts,
    workouts: [...workoutAggregates.values()].sort((a, b) => String(b.latestAt ?? "").localeCompare(String(a.latestAt ?? ""))),
    programs: [...programAggregates.values()].sort((a, b) => String(b.latestAt ?? "").localeCompare(String(a.latestAt ?? ""))),
    movements: [...movementAggregates.values()].sort((a, b) => b.setCount - a.setCount || a.canonicalKey.localeCompare(b.canonicalKey)),
    qualityFlags: sortObjectKeys({
      missing_program_id_workouts: recentWorkouts.filter((workout) => !workout.programId).length,
      unmapped_movements: [...movementAggregates.values()].filter((movement) => !movement.mapped).map((movement) => movement.canonicalKey),
      low_mapping_workouts: recentWorkouts.filter((workout) => workout.mappedMovementPct < 70).map((workout) => workout.activityId),
      title_coverage_missing: recentWorkouts.filter((workout) => !workout.workoutId).length === recentWorkouts.length,
    }),
    raw: sortObjectKeys({
      profile: {
        user_id: typeof toObj(root.profile).userId === "string" ? String(toObj(root.profile).userId) : null,
        total_workouts: toNum(toObj(root.profile).totalWorkouts),
      },
      top_workout_ids: recentWorkouts.slice(0, 10).map((workout) => workout.workoutId),
      top_program_ids: recentWorkouts.slice(0, 10).map((workout) => workout.programId),
    }),
  };

  return catalog;
}

export function catalogMovementCandidatesForSlot(input: {
  catalog: TonalProgramCatalog;
  targetMuscles: string[];
  preferredPatterns?: string[];
  excludeMovementIds?: string[];
  limit?: number;
}): TonalCatalogMovement[] {
  const targetMuscles = new Set(input.targetMuscles);
  const preferredPatterns = new Set(input.preferredPatterns ?? []);
  const exclude = new Set(input.excludeMovementIds ?? []);
  return input.catalog.movements
    .filter((movement) => !exclude.has(movement.movementId))
    .filter((movement) => targetMuscles.has(movement.muscleGroup) || preferredPatterns.has(movement.pattern))
    .sort((a, b) => {
      const aPatternBonus = preferredPatterns.has(a.pattern) ? 1 : 0;
      const bPatternBonus = preferredPatterns.has(b.pattern) ? 1 : 0;
      return (
        (b.mapped ? 1 : 0) - (a.mapped ? 1 : 0)
        || bPatternBonus - aPatternBonus
        || b.setCount - a.setCount
        || (b.confidence - a.confidence)
        || a.canonicalKey.localeCompare(b.canonicalKey)
      );
    })
    .slice(0, input.limit ?? 4);
}
