export type TonalMuscleGroup =
  | "chest"
  | "back"
  | "lats"
  | "shoulders"
  | "rear_delts"
  | "biceps"
  | "triceps"
  | "quads"
  | "hamstrings"
  | "glutes"
  | "calves"
  | "core"
  | "full_body"
  | "unmapped";

export type TonalMovementPattern =
  | "press"
  | "row"
  | "pull_down"
  | "squat"
  | "hinge"
  | "lunge"
  | "curl"
  | "extension"
  | "raise"
  | "fly"
  | "rotation"
  | "anti_rotation"
  | "plank"
  | "carry"
  | "other";

export type TonalMovementResolution = {
  movementKey: string;
  movementId: string | null;
  movementTitle: string | null;
  muscleGroup: TonalMuscleGroup;
  pattern: TonalMovementPattern;
  confidence: number;
  confidenceLabel: "high" | "medium" | "low";
  mapped: boolean;
  aliases: string[];
  reason: string | null;
};

type TonalMovementDefinition = {
  canonicalKey: string;
  movementIds: string[];
  aliases: string[];
  muscleGroup: Exclude<TonalMuscleGroup, "unmapped">;
  pattern: Exclude<TonalMovementPattern, "other">;
  confidence: number;
};

type TonalExcludedMovement = {
  canonicalKey: string;
  movementIds: string[];
  aliases: string[];
  reason: string;
};

type ResolvedDefinitionMatch = {
  definition: TonalMovementDefinition;
  matchedKey: "movementId" | "movementTitle";
  matchedAlias: string;
};

export type TonalMovementInput = {
  movementId?: string | number | null;
  movementTitle?: string | null;
  title?: string | null;
  name?: string | null;
};

function defineTonalMovement(
  definition: Omit<TonalMovementDefinition, "aliases" | "movementIds"> & {
    aliases?: string[];
    movementIds?: string[];
  },
): TonalMovementDefinition {
  return {
    ...definition,
    movementIds: uniqueStrings(definition.movementIds ?? []),
    aliases: uniqueStrings([definition.canonicalKey, ...(definition.aliases ?? [])]),
  };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalizeTonalMovementKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

const TONAL_EXCLUDED_MOVEMENTS: TonalExcludedMovement[] = [
  {
    canonicalKey: "rest",
    movementIds: ["00000000-0000-0000-0000-000000000005"],
    aliases: ["rest"],
    reason: 'Excluded Tonal placeholder movement "Rest".',
  },
];

export const TONAL_MOVEMENT_DEFINITIONS: TonalMovementDefinition[] = [
  defineTonalMovement({
    canonicalKey: "split squat",
    movementIds: ["c7737825-dd6f-44b4-9b25-6ee66b43d07d"],
    aliases: ["Split Squat"],
    muscleGroup: "quads",
    pattern: "lunge",
    confidence: 0.98,
  }),
  defineTonalMovement({
    canonicalKey: "lateral bridge w row",
    movementIds: ["d509c836-0e78-48d5-8daf-3900add72be4"],
    aliases: ["Lateral Bridge w/ Row", "Lateral Bridge with Row", "Side Plank Row"],
    muscleGroup: "core",
    pattern: "anti_rotation",
    confidence: 0.95,
  }),
  defineTonalMovement({
    canonicalKey: "bench press",
    movementIds: ["8edc0211-4594-4e5e-8e1b-b05dfc1d67c7"],
    aliases: ["Bench Press"],
    muscleGroup: "chest",
    pattern: "press",
    confidence: 0.98,
  }),
  defineTonalMovement({
    canonicalKey: "decline chest fly",
    movementIds: ["f4d78bdf-f70c-4f3c-bccb-78e9ff80f9fb"],
    aliases: ["Decline Chest Fly", "Decline Fly"],
    muscleGroup: "chest",
    pattern: "fly",
    confidence: 0.97,
  }),
  defineTonalMovement({
    canonicalKey: "triceps extension",
    movementIds: ["8571813d-b302-4cbe-a3b5-cc805a046b7d"],
    aliases: ["Triceps Extension"],
    muscleGroup: "triceps",
    pattern: "extension",
    confidence: 0.98,
  }),
  defineTonalMovement({
    canonicalKey: "barbell rdl",
    movementIds: ["ef5f1802-a99e-4e56-b473-32bbf353fb73"],
    aliases: ["Barbell RDL", "Romanian Deadlift", "RDL"],
    muscleGroup: "hamstrings",
    pattern: "hinge",
    confidence: 0.98,
  }),
  defineTonalMovement({
    canonicalKey: "barbell bent over row",
    movementIds: ["ec9edd5f-4745-45b7-b78b-b7368839ca38"],
    aliases: ["Barbell Bent Over Row", "Bent Over Row"],
    muscleGroup: "back",
    pattern: "row",
    confidence: 0.98,
  }),
  defineTonalMovement({
    canonicalKey: "neutral lat pulldown",
    movementIds: ["0c498470-12f9-4b8b-83e8-940e70f7b967"],
    aliases: ["Neutral Lat Pulldown", "Lat Pulldown"],
    muscleGroup: "lats",
    pattern: "pull_down",
    confidence: 0.98,
  }),
  defineTonalMovement({
    canonicalKey: "barbell biceps curl",
    movementIds: ["0b5e580d-f813-4f4e-81ae-2ed559f88a93"],
    aliases: ["Barbell Biceps Curl", "Biceps Curl"],
    muscleGroup: "biceps",
    pattern: "curl",
    confidence: 0.98,
  }),
  defineTonalMovement({
    canonicalKey: "standing barbell overhead press",
    movementIds: ["eabcfa09-599a-4efd-8997-de107832de01"],
    aliases: ["Standing Barbell Overhead Press", "Overhead Press", "Shoulder Press"],
    muscleGroup: "shoulders",
    pattern: "press",
    confidence: 0.97,
  }),
  defineTonalMovement({
    canonicalKey: "middle chest fly",
    movementIds: ["e12dd59c-f1c3-4e2d-bc54-593863b643d0"],
    aliases: ["Middle Chest Fly", "Middle Fly"],
    muscleGroup: "chest",
    pattern: "fly",
    confidence: 0.97,
  }),
  defineTonalMovement({
    canonicalKey: "incline chest fly",
    movementIds: ["f99ab88a-190a-42bb-b145-298b83b39233"],
    aliases: ["Incline Chest Fly"],
    muscleGroup: "chest",
    pattern: "fly",
    confidence: 0.97,
  }),
  defineTonalMovement({
    canonicalKey: "barbell straight arm pulldown",
    movementIds: ["f94f667d-5fe2-4bf7-b87e-ca705d5b627d"],
    aliases: ["Barbell Straight Arm Pulldown", "Straight Arm Pulldown"],
    muscleGroup: "lats",
    pattern: "pull_down",
    confidence: 0.97,
  }),
  defineTonalMovement({
    canonicalKey: "overhead triceps extension",
    movementIds: ["9b0b0dad-6f86-4832-9dee-e6eaf4fad8b9"],
    aliases: ["Overhead Triceps Extension"],
    muscleGroup: "triceps",
    pattern: "extension",
    confidence: 0.98,
  }),
  defineTonalMovement({
    canonicalKey: "standing chop",
    movementIds: ["596e7a05-1086-4045-84fb-2b8a2edc88dd"],
    aliases: ["Standing Chop", "Wood Chop"],
    muscleGroup: "core",
    pattern: "rotation",
    confidence: 0.95,
  }),
  defineTonalMovement({
    canonicalKey: "iso split squat lift",
    movementIds: ["b68dd564-eb27-4b76-904f-67e25cf6de8c"],
    aliases: ["Iso Split Squat Lift"],
    muscleGroup: "core",
    pattern: "rotation",
    confidence: 0.93,
  }),
  defineTonalMovement({
    canonicalKey: "resisted lateral lunge",
    movementIds: ["f8bad1ec-c502-4379-b2f4-e9198245e534"],
    aliases: ["Resisted Lateral Lunge", "Lateral Lunge"],
    muscleGroup: "glutes",
    pattern: "lunge",
    confidence: 0.96,
  }),
  defineTonalMovement({
    canonicalKey: "barbell seated overhead press",
    movementIds: ["a906fa8b-a55d-4acf-b350-c6b12f77bf40"],
    aliases: ["Barbell Seated Overhead Press", "Seated Overhead Press", "Seated Shoulder Press"],
    muscleGroup: "shoulders",
    pattern: "press",
    confidence: 0.97,
  }),
  defineTonalMovement({
    canonicalKey: "barbell front raise",
    movementIds: ["5c740fbf-6d28-4fba-912d-040e4d1c92e1"],
    aliases: ["Barbell Front Raise", "Front Raise"],
    muscleGroup: "shoulders",
    pattern: "raise",
    confidence: 0.96,
  }),
];

const TONAL_MOVEMENT_INDEX = TONAL_MOVEMENT_DEFINITIONS.flatMap((definition) =>
  definition.aliases.map((alias) => ({
    alias,
    normalizedAlias: normalizeTonalMovementKey(alias),
    definition,
  })),
).sort((left, right) => right.normalizedAlias.length - left.normalizedAlias.length);

const TONAL_MOVEMENT_ID_INDEX = new Map(
  TONAL_MOVEMENT_DEFINITIONS.flatMap((definition) =>
    definition.movementIds.map((movementId) => [normalizeTonalMovementKey(movementId), definition] as const),
  ),
);

const TONAL_EXCLUDED_ID_INDEX = new Map(
  TONAL_EXCLUDED_MOVEMENTS.flatMap((definition) =>
    definition.movementIds.map((movementId) => [normalizeTonalMovementKey(movementId), definition] as const),
  ),
);

const TONAL_EXCLUDED_ALIAS_INDEX = new Map(
  TONAL_EXCLUDED_MOVEMENTS.flatMap((definition) =>
    definition.aliases.map((alias) => [normalizeTonalMovementKey(alias), definition] as const),
  ),
);

function confidenceLabel(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}

function asString(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function normalizeTonalMovementKey(value: string | number | null | undefined): string {
  const text = asString(value);
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/[_/|]+/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsWholePhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  if (haystack === needle) return true;
  return new RegExp(`(?:^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(haystack);
}

function scoreMatch(candidate: string, alias: string): number {
  if (!candidate || !alias) return 0;
  if (candidate === alias) return 3;
  if (containsWholePhrase(candidate, alias)) return 2 + Math.min(0.5, alias.length / 100);
  return 0;
}

function resolveExcludedMovement(
  movementId: string | null,
  movementTitle: string | null,
): TonalExcludedMovement | null {
  const normalizedId = normalizeTonalMovementKey(movementId);
  if (normalizedId && TONAL_EXCLUDED_ID_INDEX.has(normalizedId)) {
    return TONAL_EXCLUDED_ID_INDEX.get(normalizedId) ?? null;
  }

  const normalizedTitle = normalizeTonalMovementKey(movementTitle);
  if (normalizedTitle && TONAL_EXCLUDED_ALIAS_INDEX.has(normalizedTitle)) {
    return TONAL_EXCLUDED_ALIAS_INDEX.get(normalizedTitle) ?? null;
  }

  return null;
}

function resolveBestDefinition(input: TonalMovementInput): ResolvedDefinitionMatch | null {
  const movementId = asString(input.movementId);
  const movementTitle = asString(input.movementTitle ?? input.title ?? input.name);
  const normalizedId = normalizeTonalMovementKey(movementId);
  if (normalizedId) {
    const definition = TONAL_MOVEMENT_ID_INDEX.get(normalizedId);
    if (definition) {
      return {
        definition,
        matchedKey: "movementId",
        matchedAlias: definition.canonicalKey,
      };
    }
  }

  const normalizedTitle = normalizeTonalMovementKey(movementTitle);
  if (!normalizedTitle) {
    return null;
  }

  let best: { definition: TonalMovementDefinition; matchedAlias: string; score: number } | null = null;
  for (const entry of TONAL_MOVEMENT_INDEX) {
    const score = scoreMatch(normalizedTitle, entry.normalizedAlias);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = {
        definition: entry.definition,
        matchedAlias: entry.alias,
        score,
      };
    }
  }

  if (!best) return null;
  return {
    definition: best.definition,
    matchedKey: "movementTitle",
    matchedAlias: best.matchedAlias,
  };
}

export function resolveTonalMovement(input: TonalMovementInput): TonalMovementResolution {
  const movementId = asString(input.movementId);
  const movementTitle = asString(input.movementTitle ?? input.title ?? input.name);
  const excluded = resolveExcludedMovement(movementId, movementTitle);

  if (excluded) {
    return {
      movementKey: normalizeTonalMovementKey(excluded.canonicalKey),
      movementId,
      movementTitle,
      muscleGroup: "unmapped",
      pattern: "other",
      confidence: 0.99,
      confidenceLabel: "high",
      mapped: false,
      aliases: excluded.aliases,
      reason: excluded.reason,
    };
  }

  const resolved = resolveBestDefinition(input);
  if (!resolved) {
    const movementKey = normalizeTonalMovementKey(movementTitle ?? movementId ?? "");
    return {
      movementKey: movementKey || "unmapped",
      movementId,
      movementTitle,
      muscleGroup: "unmapped",
      pattern: "other",
      confidence: 0.18,
      confidenceLabel: "low",
      mapped: false,
      aliases: [],
      reason: movementTitle
        ? `No Tonal movement mapping matched "${movementTitle}".`
        : movementId
          ? `No Tonal movement mapping matched movement id ${movementId}.`
          : "Missing Tonal movement identifier and title.",
    };
  }

  const movementKey = normalizeTonalMovementKey(resolved.definition.canonicalKey);
  const matchedAlias = resolved.matchedAlias;
  const exactMatch =
    resolved.matchedKey === "movementId"
      ? true
      : normalizeTonalMovementKey(matchedAlias) === normalizeTonalMovementKey(movementTitle);
  const confidence =
    resolved.matchedKey === "movementId"
      ? resolved.definition.confidence
      : exactMatch
        ? resolved.definition.confidence
        : Number((resolved.definition.confidence - 0.08).toFixed(2));

  return {
    movementKey,
    movementId,
    movementTitle,
    muscleGroup: resolved.definition.muscleGroup,
    pattern: resolved.definition.pattern,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    mapped: true,
    aliases: resolved.definition.aliases,
    reason:
      resolved.matchedKey === "movementId"
        ? `Matched Tonal movement id ${movementId} -> "${resolved.definition.canonicalKey}".`
        : exactMatch
          ? `Matched Tonal movement alias "${matchedAlias}".`
          : `Matched Tonal movement family "${resolved.definition.canonicalKey}" via alias "${matchedAlias}".`,
  };
}
