#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";

import { TONAL_MOVEMENT_DEFINITIONS, type TonalMuscleGroup, type TonalMovementPattern } from "./tonal-movement-map.js";

const PUBLIC_CATALOG_PATH = "/Users/hd/Developer/cortana/memory/fitness/programs/json/tonal-public-movement-catalog.json";
const OBSERVED_CATALOG_PATH = "/Users/hd/Developer/cortana/memory/fitness/programs/json/current-tonal-catalog.json";
const OUTPUT_JSON_PATH = "/Users/hd/Developer/cortana/memory/fitness/programs/json/tonal-ppl-v1.json";
const OUTPUT_MARKDOWN_PATH = "/Users/hd/Developer/cortana/memory/fitness/programs/md/tonal-ppl-v1.md";

type ValidationSource = "public_library" | "observed_history";
type DayKey = "push" | "pull" | "legs";

type PublicMovementRow = {
  title: string;
  movementId: string | null;
  metricReady: boolean;
  publicUrl: string;
  pplBucket: "push" | "pull" | "legs" | "core" | "other";
  muscleGroup: TonalMuscleGroup;
  pattern: TonalMovementPattern;
};

type PublicCatalog = {
  summary?: {
    publicMovementCount?: number;
    metricReadyCount?: number;
    observedCount?: number;
  };
  movements?: PublicMovementRow[];
};

type ObservedMovementRow = {
  movementId: string;
  canonicalKey: string;
  sampleTitle: string | null;
  muscleGroup: TonalMuscleGroup;
  pattern: TonalMovementPattern;
  setCount: number;
  workoutCount: number;
  avgLoad: number | null;
  avgReps: number | null;
  avgVolume: number | null;
  mapped: boolean;
};

type ObservedCatalog = {
  summary?: {
    workoutsSeen?: number;
    movementsSeen?: number;
    mappedMovementPct?: number;
    latestWorkoutAt?: string | null;
  };
  movements?: ObservedMovementRow[];
};

type MergedMovementCandidate = {
  movementId: string;
  title: string;
  canonicalKey: string;
  muscleGroup: TonalMuscleGroup;
  pattern: TonalMovementPattern;
  pplBucket: DayKey | "core" | "other";
  validationSources: ValidationSource[];
  publicTitles: string[];
  publicUrls: string[];
  observed: {
    setCount: number;
    workoutCount: number;
    avgLoad: number | null;
    avgReps: number | null;
    avgVolume: number | null;
  } | null;
};

type TonalPplMovement = {
  slot: string;
  title: string;
  movementId: string;
  canonicalKey: string;
  muscleGroup: TonalMuscleGroup;
  pattern: TonalMovementPattern;
  validationSources: ValidationSource[];
  publicUrls: string[];
  recentHistory: {
    setCount: number;
    workoutCount: number;
    avgLoad: number | null;
    avgReps: number | null;
    avgVolume: number | null;
  } | null;
  programming: {
    sets: string;
    reps: string;
    rir: string;
    note: string;
  };
  alternates: string[];
  selectionReason: string;
};

export type TonalPplPlan = {
  schema: "spartan.tonal_ppl_v1";
  generatedAt: string;
  source: {
    publicCatalogPath: string;
    observedCatalogPath: string;
  };
  summary: {
    workoutsSeen: number;
    mappedMovementsSeen: number;
    latestWorkoutAt: string | null;
    publicMovementCount: number;
    metricReadyPublicMovementCount: number;
    observedPublicMovementCount: number;
  };
  notes: string[];
  days: Record<DayKey, {
    theme: string;
    whyThisFits: string;
    movements: TonalPplMovement[];
  }>;
};

type SlotConfig = {
  slot: string;
  day: DayKey;
  sets: string;
  reps: string;
  rir: string;
  note: string;
  predicate: (candidate: MergedMovementCandidate) => boolean;
};

const TITLE_CASE_OVERRIDES: Record<string, string> = {
  "barbell biceps curl": "Barbell Biceps Curl",
  "triceps extension": "Triceps Extension",
  "overhead triceps extension": "Overhead Triceps Extension",
  "barbell bent over row": "Barbell Bent Over Row",
  "barbell rdl": "Barbell RDL",
  "standing barbell overhead press": "Standing Barbell Overhead Press",
  "barbell seated overhead press": "Barbell Seated Overhead Press",
  "barbell front rack split squat": "Barbell Front Rack Split Squat",
  "barbell front raise": "Barbell Front Raise",
  "neutral lat pulldown": "Neutral Grip Lat Pulldown",
  "bench press": "Bench Press",
  "decline chest fly": "Decline Chest Fly",
  "middle chest fly": "Middle Chest Fly",
  "incline chest fly": "Incline Chest Fly",
  "standing chop": "Standing Chop",
  "iso split squat lift": "ISO Split Squat Lift",
  "lateral bridge w row": "Lateral Bridge With Row",
  "resisted lateral lunge": "Lateral Lunge",
  "barbell straight arm pulldown": "Straight Arm Pulldown",
};

const SLOT_CONFIGS: SlotConfig[] = [
  {
    slot: "main_press",
    day: "push",
    sets: "4",
    reps: "6-10",
    rir: "1-2",
    note: "Run this as the main progression lift for the day.",
    predicate: (candidate) => candidate.muscleGroup === "chest" && candidate.pattern === "press",
  },
  {
    slot: "vertical_press",
    day: "push",
    sets: "3",
    reps: "6-10",
    rir: "1-2",
    note: "Second compound. Keep reps clean and stop before grinders.",
    predicate: (candidate) => candidate.muscleGroup === "shoulders" && candidate.pattern === "press",
  },
  {
    slot: "chest_accessory",
    day: "push",
    sets: "3",
    reps: "10-15",
    rir: "1-2",
    note: "Controlled stretch and squeeze. No sloppy fatigue chasing.",
    predicate: (candidate) => candidate.muscleGroup === "chest" && candidate.pattern === "fly",
  },
  {
    slot: "delt_accessory",
    day: "push",
    sets: "2-3",
    reps: "10-15",
    rir: "1-2",
    note: "Use this to finish shoulders without turning the day into junk volume.",
    predicate: (candidate) => candidate.muscleGroup === "shoulders" && candidate.pattern === "raise",
  },
  {
    slot: "triceps_1",
    day: "push",
    sets: "3",
    reps: "10-15",
    rir: "1-2",
    note: "Lock in elbow-friendly reps and keep tension on triceps.",
    predicate: (candidate) => candidate.muscleGroup === "triceps" && candidate.pattern === "extension",
  },
  {
    slot: "triceps_2",
    day: "push",
    sets: "2-3",
    reps: "12-15",
    rir: "1-2",
    note: "Optional second triceps slot if elbows feel good and recovery is solid.",
    predicate: (candidate) => candidate.muscleGroup === "triceps" && candidate.pattern === "extension",
  },
  {
    slot: "row",
    day: "pull",
    sets: "4",
    reps: "6-10",
    rir: "1-2",
    note: "Main horizontal pull. Stay strict and own the torso position.",
    predicate: (candidate) => candidate.muscleGroup === "back" && candidate.pattern === "row",
  },
  {
    slot: "lat_pulldown",
    day: "pull",
    sets: "4",
    reps: "6-10",
    rir: "1-2",
    note: "Primary vertical pull. Keep shoulders down and ribs stacked.",
    predicate: (candidate) => candidate.muscleGroup === "lats" && candidate.pattern === "pull_down",
  },
  {
    slot: "lat_accessory",
    day: "pull",
    sets: "3",
    reps: "10-15",
    rir: "1-2",
    note: "Smooth lat accessory volume without stealing recovery from compounds.",
    predicate: (candidate) => candidate.muscleGroup === "lats" && candidate.pattern === "pull_down",
  },
  {
    slot: "biceps",
    day: "pull",
    sets: "3",
    reps: "8-12",
    rir: "1-2",
    note: "Simple arm work. Full range and no torso swing.",
    predicate: (candidate) => candidate.muscleGroup === "biceps" && candidate.pattern === "curl",
  },
  {
    slot: "trunk",
    day: "pull",
    sets: "2-3",
    reps: "10-15 / side",
    rir: "2",
    note: "Use this as trunk control work that still complements the pull day.",
    predicate: (candidate) => candidate.muscleGroup === "core" && candidate.pattern === "anti_rotation",
  },
  {
    slot: "quad_anchor",
    day: "legs",
    sets: "4",
    reps: "6-10 / side",
    rir: "1-2",
    note: "Main quad pattern. Start here and drive the session.",
    predicate: (candidate) => candidate.muscleGroup === "quads" && candidate.pattern === "lunge",
  },
  {
    slot: "hinge_anchor",
    day: "legs",
    sets: "4",
    reps: "6-10",
    rir: "1-2",
    note: "Main posterior-chain lift. Keep hamstrings loaded and spine quiet.",
    predicate: (candidate) => candidate.muscleGroup === "hamstrings" && candidate.pattern === "hinge",
  },
  {
    slot: "frontal_plane",
    day: "legs",
    sets: "3",
    reps: "8-12 / side",
    rir: "1-2",
    note: "Good change-of-plane work for hips and glutes without huge recovery cost.",
    predicate: (candidate) => candidate.muscleGroup === "glutes" && candidate.pattern === "lunge",
  },
  {
    slot: "rotational_core",
    day: "legs",
    sets: "2-3",
    reps: "10-12 / side",
    rir: "2",
    note: "Finish with trunk work that keeps the lower day athletic and controlled.",
    predicate: (candidate) => candidate.muscleGroup === "core" && candidate.pattern === "rotation",
  },
];

function toTitleCase(input: string): string {
  const normalized = input
    .replace(/\bw\b\/\b/gi, "w/ ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return normalized;
  const override = TITLE_CASE_OVERRIDES[normalized.toLowerCase()];
  if (override) return override;
  return normalized
    .split(" ")
    .map((part) => (part === "RDL" || part === "ISO" ? part : `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`))
    .join(" ");
}

function round(value: number | null, digits = 1): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function ensureStringArray(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function buildMergedCandidates(input: {
  publicCatalog: PublicCatalog;
  observedCatalog: ObservedCatalog;
}): MergedMovementCandidate[] {
  const publicById = new Map<string, { titles: string[]; urls: string[]; row: PublicMovementRow }>();
  for (const movement of input.publicCatalog.movements ?? []) {
    if (!movement.metricReady || !movement.movementId) continue;
    const existing = publicById.get(movement.movementId) ?? { titles: [], urls: [], row: movement };
    existing.titles.push(movement.title);
    existing.urls.push(movement.publicUrl);
    publicById.set(movement.movementId, existing);
  }

  const observedById = new Map<string, ObservedMovementRow>();
  for (const movement of input.observedCatalog.movements ?? []) {
    if (!movement.mapped || !movement.movementId) continue;
    observedById.set(movement.movementId, movement);
  }

  const candidates: MergedMovementCandidate[] = [];
  for (const definition of TONAL_MOVEMENT_DEFINITIONS) {
    const movementId = definition.movementIds[0];
    if (!movementId) continue;
    const publicEntry = publicById.get(movementId);
    const observedEntry = observedById.get(movementId);
    if (!publicEntry && !observedEntry) continue;

    const validationSources: ValidationSource[] = [];
    if (publicEntry) validationSources.push("public_library");
    if (observedEntry) validationSources.push("observed_history");

    const preferredPublicTitle = publicEntry?.titles.find((title) => title === toTitleCase(definition.canonicalKey))
      ?? publicEntry?.titles[0]
      ?? toTitleCase(definition.aliases[0] ?? definition.canonicalKey);

    candidates.push({
      movementId,
      title: preferredPublicTitle,
      canonicalKey: definition.canonicalKey,
      muscleGroup: definition.muscleGroup,
      pattern: definition.pattern,
      pplBucket:
        definition.muscleGroup === "core"
          ? "core"
          : ["chest", "shoulders", "triceps"].includes(definition.muscleGroup)
            ? "push"
            : ["back", "lats", "rear_delts", "biceps"].includes(definition.muscleGroup)
              ? "pull"
              : ["quads", "hamstrings", "glutes", "calves"].includes(definition.muscleGroup)
                ? "legs"
                : "other",
      validationSources,
      publicTitles: ensureStringArray(publicEntry?.titles ?? []),
      publicUrls: ensureStringArray(publicEntry?.urls ?? []),
      observed: observedEntry
        ? {
            setCount: observedEntry.setCount,
            workoutCount: observedEntry.workoutCount,
            avgLoad: round(observedEntry.avgLoad),
            avgReps: round(observedEntry.avgReps),
            avgVolume: round(observedEntry.avgVolume),
          }
        : null,
    });
  }

  return candidates;
}

function candidateScore(candidate: MergedMovementCandidate): number {
  const observedScore = candidate.observed?.setCount ?? 0;
  const sourceScore =
    (candidate.validationSources.includes("public_library") ? 20 : 0)
    + (candidate.validationSources.includes("observed_history") ? 30 : 0);
  return observedScore * 100 + sourceScore;
}

function buildAlternates(primary: MergedMovementCandidate, candidates: MergedMovementCandidate[], predicate: SlotConfig["predicate"]): string[] {
  return candidates
    .filter((candidate) => candidate.movementId !== primary.movementId)
    .filter(predicate)
    .sort((a, b) => candidateScore(b) - candidateScore(a) || a.title.localeCompare(b.title))
    .slice(0, 3)
    .map((candidate) => candidate.title);
}

function selectionReasonFor(candidate: MergedMovementCandidate): string {
  const parts = [];
  if (candidate.validationSources.includes("public_library")) parts.push("public Tonal movement library");
  if (candidate.validationSources.includes("observed_history")) parts.push("your workout history");
  const observed = candidate.observed;
  if (observed?.setCount) {
    parts.push(`${observed.setCount} tracked sets`);
  }
  if (observed?.avgLoad != null) {
    parts.push(`~${observed.avgLoad} lb recent average load`);
  }
  return `Validated by ${parts.join(", ")}.`;
}

export function buildTonalPplV1(input: {
  publicCatalog: PublicCatalog;
  observedCatalog: ObservedCatalog;
}): TonalPplPlan {
  const candidates = buildMergedCandidates(input);
  const usedIds = new Set<string>();

  const pickSlot = (config: SlotConfig): TonalPplMovement | null => {
    const selected = candidates
      .filter(config.predicate)
      .filter((candidate) => !usedIds.has(candidate.movementId))
      .sort((a, b) => candidateScore(b) - candidateScore(a) || a.title.localeCompare(b.title))[0];
    if (!selected) return null;
    usedIds.add(selected.movementId);
    return {
      slot: config.slot,
      title: selected.title,
      movementId: selected.movementId,
      canonicalKey: selected.canonicalKey,
      muscleGroup: selected.muscleGroup,
      pattern: selected.pattern,
      validationSources: selected.validationSources,
      publicUrls: selected.publicUrls,
      recentHistory: selected.observed,
      programming: {
        sets: config.sets,
        reps: config.reps,
        rir: config.rir,
        note: config.note,
      },
      alternates: buildAlternates(selected, candidates, config.predicate),
      selectionReason: selectionReasonFor(selected),
    };
  };

  const days: TonalPplPlan["days"] = {
    push: {
      theme: "chest + shoulders + triceps with movements you already handle well on Tonal",
      whyThisFits: "Push day leans on your most repeated press and fly patterns, then finishes with shoulder and triceps work you have already logged successfully.",
      movements: [],
    },
    pull: {
      theme: "lats + upper back + biceps with stable machine-supported pulling patterns",
      whyThisFits: "Pull day uses the row and pulldown patterns you already repeat most, then adds simple lat and biceps work without inventing unsupported movements.",
      movements: [],
    },
    legs: {
      theme: "single-leg quad work + hinge + frontal-plane glute work with trunk control",
      whyThisFits: "Leg day mirrors the lower-body patterns you already use most on Tonal, which keeps the plan realistic and trackable.",
      movements: [],
    },
  };

  for (const config of SLOT_CONFIGS) {
    const selected = pickSlot(config);
    if (selected) days[config.day].movements.push(selected);
  }

  return {
    schema: "spartan.tonal_ppl_v1",
    generatedAt: new Date().toISOString(),
    source: {
      publicCatalogPath: PUBLIC_CATALOG_PATH,
      observedCatalogPath: OBSERVED_CATALOG_PATH,
    },
    summary: {
      workoutsSeen: input.observedCatalog.summary?.workoutsSeen ?? 0,
      mappedMovementsSeen: (input.observedCatalog.movements ?? []).filter((movement) => movement.mapped).length,
      latestWorkoutAt: input.observedCatalog.summary?.latestWorkoutAt ?? null,
      publicMovementCount: input.publicCatalog.summary?.publicMovementCount ?? 0,
      metricReadyPublicMovementCount: input.publicCatalog.summary?.metricReadyCount ?? 0,
      observedPublicMovementCount: input.publicCatalog.summary?.observedCount ?? 0,
    },
    notes: [
      "This is a v1 hypertrophy-oriented PPL built only from Tonal-supported movements that are locally mapped and validated by the public library, your own machine history, or both.",
      "Use your recent average load as a reference point, not a hard prescription. Let the target rep range and 1-2 RIR drive the final load on the day.",
      "If recovery is yellow or red, trim one accessory slot before you trim the main lift.",
      "Weekly hard-set volume matters more than whether the split is labeled PPL or full body. If schedule allows, run this as a rolling split so muscles are exposed roughly twice every 7-10 days instead of only once per week.",
      "Keep compounds mostly 1-2 RIR and accessories 0-2 RIR. You do not need routine failure work on presses, rows, split squats, or RDLs to grow.",
      "Rest 2-3 minutes on the main compound lifts and 60-120 seconds on fly, raise, curl, triceps, and trunk accessories so the quality of the hard sets stays high.",
      "Because you also run, keep hard running and the legs day separated by about 24 hours when possible, or reduce one accessory slot on the lower day if the run load was already high.",
    ],
    days,
  };
}

export function renderTonalPplV1Markdown(plan: TonalPplPlan): string {
  const lines = [
    "# Tonal PPL v1",
    "",
    `- Generated: ${plan.generatedAt}`,
    `- Workouts analyzed: ${plan.summary.workoutsSeen}`,
    `- Mapped movements seen: ${plan.summary.mappedMovementsSeen}`,
    `- Latest workout at: ${plan.summary.latestWorkoutAt ?? "unknown"}`,
    `- Public movement catalog count: ${plan.summary.publicMovementCount}`,
    `- Metric-ready public movements: ${plan.summary.metricReadyPublicMovementCount}`,
    `- Public movements also seen on your machine: ${plan.summary.observedPublicMovementCount}`,
    "",
    "## Notes",
    "",
    ...plan.notes.map((note) => `- ${note}`),
    "",
  ];

  for (const day of ["push", "pull", "legs"] as DayKey[]) {
    const section = plan.days[day];
    lines.push(`## ${day[0].toUpperCase()}${day.slice(1)}`);
    lines.push("");
    lines.push(`- Theme: ${section.theme}`);
    lines.push(`- Why this fits: ${section.whyThisFits}`);
    lines.push("");
    for (const movement of section.movements) {
      const avgLoad = movement.recentHistory?.avgLoad != null ? ` | recent avg load ~${movement.recentHistory.avgLoad} lb` : "";
      const alternates = movement.alternates.length > 0 ? ` | alternates: ${movement.alternates.join(", ")}` : "";
      lines.push(`- ${movement.title}: ${movement.programming.sets} sets x ${movement.programming.reps} reps @ ${movement.programming.rir} RIR${avgLoad}${alternates}`);
      lines.push(`  - ${movement.programming.note}`);
      lines.push(`  - ${movement.selectionReason}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function persistTonalPplV1(
  plan: TonalPplPlan,
  options?: { jsonPath?: string; markdownPath?: string },
): { jsonPath: string; markdownPath: string } {
  const jsonPath = options?.jsonPath ?? OUTPUT_JSON_PATH;
  const markdownPath = options?.markdownPath ?? OUTPUT_MARKDOWN_PATH;
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, renderTonalPplV1Markdown(plan), "utf8");
  return { jsonPath, markdownPath };
}

async function main(): Promise<void> {
  const publicCatalog = readJson<PublicCatalog>(PUBLIC_CATALOG_PATH);
  const observedCatalog = readJson<ObservedCatalog>(OBSERVED_CATALOG_PATH);
  const plan = buildTonalPplV1({ publicCatalog, observedCatalog });
  const write = persistTonalPplV1(plan);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    summary: plan.summary,
    json_path: write.jsonPath,
    markdown_path: write.markdownPath,
  })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
