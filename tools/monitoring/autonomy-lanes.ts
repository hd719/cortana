import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AutonomyPosture = "conservative" | "balanced" | "aggressive";
export type ReliabilityLane = "routine" | "family_critical";

type ConfigShape = {
  posture?: AutonomyPosture;
  familyCriticalCronNames?: string[];
  notes?: string[];
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CONFIG_PATH = path.join(ROOT, "config", "autonomy-lanes.json");

const DEFAULT_FAMILY_CRITICAL_CRON_NAMES = [
  "📅 Calendar reminders → Telegram (ALL calendars)",
  "🗓️ Tomorrow calendar prep",
  "✈️ Travel & logistics reminders",
  "🤰 Pregnancy reminders / checklist",
];

export function getDefaultAutonomyConfig(): Required<ConfigShape> {
  return {
    posture: "balanced",
    familyCriticalCronNames: [...DEFAULT_FAMILY_CRITICAL_CRON_NAMES],
    notes: [
      "family-critical lanes are never-miss operations: appointments, reminders, family logistics, pregnancy-sensitive reminders/checklists, and other time-sensitive personal ops",
      "balanced is the default posture: one bounded remediation attempt, then verify and escalate",
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
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.notes;
    return {
      posture,
      familyCriticalCronNames: familyCriticalCronNames.length ? familyCriticalCronNames : fallback.familyCriticalCronNames,
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
