import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localYmd } from "./signal-utils.js";

export type MealEntry = {
  timestamp: string;
  date: string;
  proteinG: number | null;
  calories: number | null;
  carbsG: number | null;
  fatG: number | null;
  note: string | null;
  sourceFile: string;
};

export type MealRollup = {
  target: {
    proteinMinG: number;
    proteinMaxG: number;
  };
  today: {
    mealsLogged: number;
    proteinG: number | null;
    calories: number | null;
    carbsG: number | null;
    fatG: number | null;
    proteinStatus: "below" | "on_target" | "above" | "unknown";
    proteinGapG: number | null;
  };
  trailing7: {
    mealsLogged: number;
    daysLogged: number;
    avgDailyProteinG: number | null;
    daysMeetingProteinTarget: number;
  };
};

type ParserAliases = "p" | "protein" | "cals" | "calories" | "carbs" | "fat" | "note";

function toNumeric(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9.+-]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeKey(key: string): ParserAliases | null {
  const k = key.toLowerCase();
  if (k === "p") return "p";
  if (k === "protein") return "protein";
  if (k === "cals") return "cals";
  if (k === "calories") return "calories";
  if (k === "carbs") return "carbs";
  if (k === "fat") return "fat";
  if (k === "note") return "note";
  return null;
}

function trimWrapped(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseSingleMealLine(mealText: string, timestamp: string, sourceFile: string, timeZone: string): MealEntry | null {
  const kvRegex = /(?:^|\s)([a-zA-Z]+)=("[^"]*"|'[^']*'|[^\s]+)/g;
  const parsed: Record<ParserAliases, string> = {} as Record<ParserAliases, string>;
  let match: RegExpExecArray | null;

  while ((match = kvRegex.exec(mealText)) !== null) {
    const key = normalizeKey(match[1]);
    if (!key) continue;
    parsed[key] = trimWrapped(match[2]);
  }

  const proteinG = toNumeric(parsed.p ?? parsed.protein);
  const calories = toNumeric(parsed.cals ?? parsed.calories);
  const carbsG = toNumeric(parsed.carbs);
  const fatG = toNumeric(parsed.fat);
  const note = parsed.note ? parsed.note.trim() : null;
  const hasSignal = proteinG != null || calories != null || carbsG != null || fatG != null || (note && note.length > 0);
  if (!hasSignal) return null;

  return {
    timestamp,
    date: localYmd(timeZone, new Date(timestamp)),
    proteinG,
    calories,
    carbsG,
    fatG,
    note: note && note.length > 0 ? note : null,
    sourceFile,
  };
}

export function extractMealEntriesFromText(text: string, timestamp: string, sourceFile: string, timeZone = "America/New_York"): MealEntry[] {
  const entries: MealEntry[] = [];
  const lineRegex = /#meal\b([^\n\r]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(text)) !== null) {
    const parsed = parseSingleMealLine(match[1] ?? "", timestamp, sourceFile, timeZone);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

type SessionMessageContent = {
  type?: string;
  text?: string;
};

type SessionLine = {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: SessionMessageContent[];
    timestamp?: number;
  };
};

function parseTimestamp(line: SessionLine): string | null {
  if (typeof line.timestamp === "string" && line.timestamp.length > 0) return line.timestamp;
  const messageTs = line.message?.timestamp;
  if (typeof messageTs === "number" && Number.isFinite(messageTs)) return new Date(messageTs).toISOString();
  return null;
}

export function readMealEntriesFromSessionFile(filePath: string, cutoffMs: number, timeZone = "America/New_York"): MealEntry[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const out: MealEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: SessionLine;
    try {
      parsed = JSON.parse(line) as SessionLine;
    } catch {
      continue;
    }
    if (parsed.type !== "message") continue;
    if (parsed.message?.role !== "user") continue;
    const timestamp = parseTimestamp(parsed);
    if (!timestamp) continue;
    const ts = new Date(timestamp).getTime();
    if (Number.isNaN(ts) || ts < cutoffMs) continue;
    const content = Array.isArray(parsed.message?.content) ? parsed.message?.content : [];
    for (const block of content) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      out.push(...extractMealEntriesFromText(block.text, timestamp, path.basename(filePath), timeZone));
    }
  }
  return out;
}

export function collectRecentMealEntries(options?: {
  days?: number;
  agentId?: string;
  timeZone?: string;
  maxFiles?: number;
}): MealEntry[] {
  const days = options?.days ?? 7;
  const maxFiles = options?.maxFiles ?? 24;
  const agentId = options?.agentId ?? "spartan";
  const timeZone = options?.timeZone ?? "America/New_York";
  const sessionDir = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions");
  if (!fs.existsSync(sessionDir)) return [];

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const candidates = fs
    .readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const fullPath = path.join(sessionDir, name);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles);

  const entries = candidates.flatMap((entry) => readMealEntriesFromSessionFile(entry.fullPath, cutoffMs, timeZone));
  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function sumNullable(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return null;
  return Number(nums.reduce((sum, n) => sum + n, 0).toFixed(2));
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number((total / values.length).toFixed(2));
}

export function summarizeMealRollup(entries: MealEntry[], todayYmd = localYmd()): MealRollup {
  const proteinMinG = 112;
  const proteinMaxG = 140;
  const todayEntries = entries.filter((entry) => entry.date === todayYmd);
  const trailing7Start = (() => {
    const d = new Date(`${todayYmd}T00:00:00`);
    d.setDate(d.getDate() - 6);
    return localYmd("America/New_York", d);
  })();
  const trailing7Entries = entries.filter((entry) => entry.date >= trailing7Start && entry.date <= todayYmd);

  const todayProtein = sumNullable(todayEntries.map((entry) => entry.proteinG));
  const proteinStatus = (() => {
    if (todayProtein == null) return "unknown";
    if (todayProtein < proteinMinG) return "below";
    if (todayProtein > proteinMaxG) return "above";
    return "on_target";
  })();

  const proteinGapG = (() => {
    if (todayProtein == null) return null;
    if (todayProtein < proteinMinG) return Number((proteinMinG - todayProtein).toFixed(2));
    if (todayProtein > proteinMaxG) return Number((todayProtein - proteinMaxG).toFixed(2));
    return 0;
  })();

  const proteinByDay = new Map<string, number>();
  for (const entry of trailing7Entries) {
    const prev = proteinByDay.get(entry.date) ?? 0;
    proteinByDay.set(entry.date, prev + (entry.proteinG ?? 0));
  }
  const proteinTotals = Array.from(proteinByDay.values());
  const daysMeetingProteinTarget = proteinTotals.filter((protein) => protein >= proteinMinG && protein <= proteinMaxG).length;

  return {
    target: {
      proteinMinG,
      proteinMaxG,
    },
    today: {
      mealsLogged: todayEntries.length,
      proteinG: todayProtein,
      calories: sumNullable(todayEntries.map((entry) => entry.calories)),
      carbsG: sumNullable(todayEntries.map((entry) => entry.carbsG)),
      fatG: sumNullable(todayEntries.map((entry) => entry.fatG)),
      proteinStatus,
      proteinGapG,
    },
    trailing7: {
      mealsLogged: trailing7Entries.length,
      daysLogged: proteinByDay.size,
      avgDailyProteinG: average(proteinTotals),
      daysMeetingProteinTarget,
    },
  };
}

