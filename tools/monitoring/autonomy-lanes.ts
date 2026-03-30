import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AutonomyPosture = "conservative" | "balanced" | "aggressive";
export type ReliabilityLane = "routine" | "family_critical";

export type VacationModeConfig = {
  enabled: boolean;
  quarantineAfterConsecutiveErrors: number;
  fragileCronMatchers: string[];
  tightenAlerting: boolean;
};

type ConfigShape = {
  posture?: AutonomyPosture;
  familyCriticalCronNames?: string[];
  familyCriticalLaneLabels?: string[];
  vacationMode?: Partial<VacationModeConfig>;
  notes?: string[];
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CONFIG_PATH = path.join(ROOT, "config", "autonomy-lanes.json");

const DEFAULT_FAMILY_CRITICAL_CRON_NAMES = [
  "📅 Calendar reminders → Telegram (ALL calendars)",
  "⏰ Apple Reminders alerts → Telegram (Monitor)",
  "🗓️ Tomorrow calendar prep",
  "✈️ Travel & logistics reminders",
  "🤰 Pregnancy reminders / checklist",
];

export function getDefaultAutonomyConfig(): Required<ConfigShape> {
  return {
    posture: "balanced",
    familyCriticalCronNames: [...DEFAULT_FAMILY_CRITICAL_CRON_NAMES],
    familyCriticalLaneLabels: [
      "appointments",
      "calendar logistics",
      "pregnancy reminders/checklists",
      "family-critical reminders",
    ],
    vacationMode: {
      enabled: false,
      quarantineAfterConsecutiveErrors: 1,
      fragileCronMatchers: [
        "🐦 Health - X Session Check",
        "📈 Stock Market Brief (daily)",
        "🧠 Polymarket Market Intel Refresh",
      ],
      tightenAlerting: true,
    },
    notes: [
      "family-critical lanes are never-miss operations: appointments, reminders, family logistics, pregnancy-sensitive reminders/checklists, and other time-sensitive personal ops",
      "balanced is the default posture: one bounded remediation attempt, then verify and escalate",
      "never-miss family-critical lanes require explicit verification; uncertain delivery after one bounded attempt pages Hamel",
    ],
  };
}

export function loadAutonomyConfig(): Required<ConfigShape> {
  const fallback = getDefaultAutonomyConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as ConfigShape;
    const posture = parsed.posture === "conservative" || parsed.posture === "aggressive" || parsed.posture === "balanced" ? parsed.posture : fallback.posture;
    const familyCriticalCronNames = Array.isArray(parsed.familyCriticalCronNames)
      ? parsed.familyCriticalCronNames.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.familyCriticalCronNames;
    const familyCriticalLaneLabels = Array.isArray(parsed.familyCriticalLaneLabels)
      ? parsed.familyCriticalLaneLabels.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.familyCriticalLaneLabels;
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.notes;
    const vacationModeRaw = parsed.vacationMode ?? {};
    const vacationMode: VacationModeConfig = {
      enabled: typeof vacationModeRaw.enabled === "boolean" ? vacationModeRaw.enabled : fallback.vacationMode.enabled,
      quarantineAfterConsecutiveErrors:
        Number.isFinite(Number(vacationModeRaw.quarantineAfterConsecutiveErrors)) &&
        Number(vacationModeRaw.quarantineAfterConsecutiveErrors) >= 1
          ? Math.floor(Number(vacationModeRaw.quarantineAfterConsecutiveErrors))
          : fallback.vacationMode.quarantineAfterConsecutiveErrors,
      fragileCronMatchers: Array.isArray(vacationModeRaw.fragileCronMatchers)
        ? vacationModeRaw.fragileCronMatchers.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : fallback.vacationMode.fragileCronMatchers,
      tightenAlerting:
        typeof vacationModeRaw.tightenAlerting === "boolean" ? vacationModeRaw.tightenAlerting : fallback.vacationMode.tightenAlerting,
    };
    return {
      posture,
      familyCriticalCronNames: familyCriticalCronNames.length ? familyCriticalCronNames : fallback.familyCriticalCronNames,
      familyCriticalLaneLabels: familyCriticalLaneLabels.length ? familyCriticalLaneLabels : fallback.familyCriticalLaneLabels,
      vacationMode,
      notes: notes.length ? notes : fallback.notes,
    };
  } catch {
    return fallback;
  }
}

export function classifyReliabilityLane(name: string): ReliabilityLane {
  const config = loadAutonomyConfig();
  return config.familyCriticalCronNames.includes(name) ? "family_critical" : "routine";
}
