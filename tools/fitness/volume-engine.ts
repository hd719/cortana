import {
  resolveSpartanPhaseDefaults,
  type SpartanMuscleGroup,
  type SpartanPhaseMode,
  type SpartanWeeklySetTargetBand,
} from "./spartan-defaults.js";

export type WeeklyMuscleDosePhaseMode = SpartanPhaseMode | "unknown";

export type WeeklyMuscleDoseStatus = "underdosed" | "adequate" | "overdosed" | "unknown";

export type WeeklyMuscleDoseSourceRow = {
  muscleGroup?: string | null;
  muscle_group?: string | null;
  hardSets?: number | null;
  hard_sets?: number | null;
  sourceConfidence?: number | null;
  source_confidence?: number | null;
};

export type WeeklyMuscleDoseBand = SpartanWeeklySetTargetBand;

export type WeeklyMuscleDoseAssessment = {
  phaseMode: WeeklyMuscleDosePhaseMode;
  muscleGroup: string;
  hardSets: number | null;
  targetBand: WeeklyMuscleDoseBand | null;
  status: WeeklyMuscleDoseStatus;
  confidence: number;
  rationale: string;
  deltaFromMin: number | null;
  deltaFromMax: number | null;
  rowCount: number;
};

export type WeeklyMuscleDosePlanInput = {
  phaseMode?: WeeklyMuscleDosePhaseMode | null;
  rows: WeeklyMuscleDoseSourceRow[];
  includeUnknownMuscleGroups?: boolean;
};

const KNOWN_MUSCLE_GROUPS: readonly SpartanMuscleGroup[] = [
  "chest",
  "back",
  "quads",
  "hamstrings",
  "glutes",
  "shoulders",
  "biceps",
  "triceps",
  "calves",
  "core",
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function normalizeMuscleGroup(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeHardSets(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(2));
}

function normalizeSourceConfidence(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return clamp(value, 0, 1);
}

function isKnownMuscleGroup(value: string): value is SpartanMuscleGroup {
  return (KNOWN_MUSCLE_GROUPS as readonly string[]).includes(value);
}

function resolveTargetBand(
  phaseMode: WeeklyMuscleDosePhaseMode | null | undefined,
  muscleGroup: string,
): WeeklyMuscleDoseBand | null {
  if (!phaseMode || phaseMode === "unknown") return null;
  if (!isKnownMuscleGroup(muscleGroup)) return null;
  return resolveSpartanPhaseDefaults(phaseMode).weeklySetTargetBands[muscleGroup];
}

function classifyKnownDose(
  muscleGroup: string,
  hardSets: number,
  band: WeeklyMuscleDoseBand,
  sourceConfidence: number | null,
  phaseMode: WeeklyMuscleDosePhaseMode,
): WeeklyMuscleDoseAssessment {
  const bandWidth = Math.max(band.maxHardSets - band.minHardSets, 1);
  const center = (band.minHardSets + band.maxHardSets) / 2;
  const distanceToMin = hardSets - band.minHardSets;
  const distanceToMax = hardSets - band.maxHardSets;

  if (hardSets < band.minHardSets) {
    const gap = band.minHardSets - hardSets;
    const baseConfidence = 0.74 + clamp(gap / bandWidth, 0, 1) * 0.18;
    const confidence = sourceConfidence == null ? baseConfidence : (baseConfidence * 0.7) + (sourceConfidence * 0.3);
    return {
      phaseMode,
      muscleGroup,
      hardSets,
      targetBand: band,
      status: "underdosed",
      confidence: round(clamp(confidence, 0.2, 0.98)),
      rationale: `${muscleGroup} is ${gap.toFixed(1)} hard sets below the ${phaseMode} band (${band.minHardSets}-${band.maxHardSets}).`,
      deltaFromMin: round(distanceToMin),
      deltaFromMax: round(distanceToMax),
      rowCount: 0,
    };
  }

  if (hardSets > band.maxHardSets) {
    const excess = hardSets - band.maxHardSets;
    const baseConfidence = 0.74 + clamp(excess / bandWidth, 0, 1) * 0.18;
    const confidence = sourceConfidence == null ? baseConfidence : (baseConfidence * 0.7) + (sourceConfidence * 0.3);
    return {
      phaseMode,
      muscleGroup,
      hardSets,
      targetBand: band,
      status: "overdosed",
      confidence: round(clamp(confidence, 0.2, 0.98)),
      rationale: `${muscleGroup} is ${excess.toFixed(1)} hard sets above the ${phaseMode} band (${band.minHardSets}-${band.maxHardSets}).`,
      deltaFromMin: round(distanceToMin),
      deltaFromMax: round(distanceToMax),
      rowCount: 0,
    };
  }

  const distanceToCenter = Math.abs(hardSets - center);
  const normalizedCenter = 1 - clamp(distanceToCenter / Math.max(bandWidth / 2, 1), 0, 1);
  const baseConfidence = 0.84 + normalizedCenter * 0.12;
  const confidence = sourceConfidence == null ? baseConfidence : (baseConfidence * 0.7) + (sourceConfidence * 0.3);

  return {
    phaseMode,
    muscleGroup,
    hardSets,
    targetBand: band,
    status: "adequate",
    confidence: round(clamp(confidence, 0.2, 0.98)),
    rationale: `${muscleGroup} sits within the ${phaseMode} band (${band.minHardSets}-${band.maxHardSets}) at ${hardSets.toFixed(1)} hard sets.`,
    deltaFromMin: round(distanceToMin),
    deltaFromMax: round(distanceToMax),
    rowCount: 0,
  };
}

function classifyUnknownDose(
  muscleGroup: string,
  hardSets: number | null,
  phaseMode: WeeklyMuscleDosePhaseMode,
  reason: string,
  rowCount: number,
): WeeklyMuscleDoseAssessment {
  return {
    phaseMode,
    muscleGroup,
    hardSets,
    targetBand: null,
    status: "unknown",
    confidence: rowCount > 0 && hardSets != null ? 0.3 : 0.18,
    rationale: reason,
    deltaFromMin: null,
    deltaFromMax: null,
    rowCount,
  };
}

export function classifyWeeklyMuscleDose(input: {
  phaseMode?: WeeklyMuscleDosePhaseMode | null;
  muscleGroup: string;
  hardSets?: number | null;
  sourceConfidence?: number | null;
  rowCount?: number;
}): WeeklyMuscleDoseAssessment {
  const phaseMode = input.phaseMode ?? "unknown";
  const muscleGroup = normalizeMuscleGroup(input.muscleGroup);
  const hardSets = normalizeHardSets(input.hardSets);
  const sourceConfidence = normalizeSourceConfidence(input.sourceConfidence);
  const rowCount = input.rowCount ?? 0;
  const band = resolveTargetBand(phaseMode, muscleGroup);

  if (!muscleGroup) {
    return classifyUnknownDose("unknown", hardSets, phaseMode, "No muscle group was provided.", rowCount);
  }

  if (phaseMode === "unknown") {
    return classifyUnknownDose(
      muscleGroup,
      hardSets,
      phaseMode,
      `Phase mode is unknown, so no weekly target band is available for ${muscleGroup}.`,
      rowCount,
    );
  }

  if (!band) {
    return classifyUnknownDose(
      muscleGroup,
      hardSets,
      phaseMode,
      `No weekly set target band is configured for ${muscleGroup} in the ${phaseMode} phase.`,
      rowCount,
    );
  }

  if (hardSets == null || hardSets < 0) {
    return classifyUnknownDose(
      muscleGroup,
      hardSets,
      phaseMode,
      `Weekly hard-set total is missing or invalid for ${muscleGroup}.`,
      rowCount,
    );
  }

  const assessment = classifyKnownDose(muscleGroup, hardSets, band, sourceConfidence, phaseMode);
  assessment.rowCount = rowCount;
  return assessment;
}

function aggregateMuscleRows(rows: WeeklyMuscleDoseSourceRow[]): Map<string, {
  hardSets: number | null;
  rowCount: number;
  sourceConfidence: number | null;
}> {
  const totals = new Map<string, { hardSets: number | null; rowCount: number; sourceConfidence: number | null }>();

  for (const row of rows) {
    const muscleGroup = normalizeMuscleGroup(row.muscleGroup ?? row.muscle_group);
    if (!muscleGroup) continue;

    const hardSets = normalizeHardSets(row.hardSets ?? row.hard_sets);
    const sourceConfidence = normalizeSourceConfidence(row.sourceConfidence ?? row.source_confidence);
    const existing = totals.get(muscleGroup) ?? { hardSets: 0, rowCount: 0, sourceConfidence: null };

    const nextHardSets = hardSets == null ? existing.hardSets : (existing.hardSets ?? 0) + hardSets;
    const nextSourceConfidence =
      sourceConfidence == null
        ? existing.sourceConfidence
        : existing.sourceConfidence == null
          ? sourceConfidence
          : (existing.sourceConfidence + sourceConfidence) / 2;

    totals.set(muscleGroup, {
      hardSets: nextHardSets == null ? null : round(nextHardSets),
      rowCount: existing.rowCount + 1,
      sourceConfidence: nextSourceConfidence == null ? null : round(nextSourceConfidence),
    });
  }

  return totals;
}

export function buildWeeklyMuscleDoseAssessments(input: WeeklyMuscleDosePlanInput): WeeklyMuscleDoseAssessment[] {
  const phaseMode = input.phaseMode ?? "unknown";
  const totals = aggregateMuscleRows(input.rows);
  const assessments: WeeklyMuscleDoseAssessment[] = [];
  const included = new Set<string>();

  for (const muscleGroup of KNOWN_MUSCLE_GROUPS) {
    const total = totals.get(muscleGroup);
    included.add(muscleGroup);

    if (!total) {
      assessments.push(classifyUnknownDose(
        muscleGroup,
        null,
        phaseMode,
        phaseMode === "unknown"
          ? `Phase mode is unknown, so no weekly target band is available for ${muscleGroup}.`
          : `No weekly hard-set rows were recorded for ${muscleGroup}.`,
        0,
      ));
      continue;
    }

    assessments.push(classifyWeeklyMuscleDose({
      phaseMode,
      muscleGroup,
      hardSets: total.hardSets,
      sourceConfidence: total.sourceConfidence,
      rowCount: total.rowCount,
    }));
  }

  if (input.includeUnknownMuscleGroups) {
    for (const [muscleGroup, total] of totals.entries()) {
      if (included.has(muscleGroup)) continue;
      assessments.push(classifyUnknownDose(
        muscleGroup,
        total.hardSets,
        phaseMode,
        `No target band is configured for ${muscleGroup}, so the weekly dose cannot be classified.`,
        total.rowCount,
      ));
    }
  }

  return assessments.sort((left, right) => {
    const leftIndex = KNOWN_MUSCLE_GROUPS.indexOf(left.muscleGroup as SpartanMuscleGroup);
    const rightIndex = KNOWN_MUSCLE_GROUPS.indexOf(right.muscleGroup as SpartanMuscleGroup);
    if (leftIndex !== -1 && rightIndex !== -1) return leftIndex - rightIndex;
    if (leftIndex !== -1) return -1;
    if (rightIndex !== -1) return 1;
    return left.muscleGroup.localeCompare(right.muscleGroup);
  });
}

