#!/usr/bin/env npx tsx

import path from "node:path";
import { spawnSync } from "node:child_process";
import { readJsonFile, writeJsonFileAtomic } from "../lib/json-file.js";
import { sourceRepoRoot } from "../lib/paths.js";

type ReminderRecord = Record<string, unknown>;

type Reminder = {
  id: string;
  title: string;
  listName: string;
  dueAt: Date;
};

type State = {
  sent?: Record<string, string>;
  meta?: {
    permissionAlertSentAt?: string;
    commandErrorAlertSentAt?: string;
  };
  updatedAt?: string;
};

const TZ = "America/New_York";
const SOON_WINDOW_MINUTES = Number(process.env.APPLE_REMINDERS_SOON_WINDOW_MINUTES ?? "60");
const MAX_LINES = Number(process.env.APPLE_REMINDERS_MAX_LINES ?? "6");
const ALERT_COOLDOWN_HOURS = Number(process.env.APPLE_REMINDERS_ALERT_COOLDOWN_HOURS ?? "12");
const STATE_PATH = path.join(sourceRepoRoot(), "memory", "apple-reminders-sent.json");

function isRecord(value: unknown): value is ReminderRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 1e12 ? value * 1000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (isRecord(value)) {
    const nested = value.dateTime ?? value.datetime ?? value.iso ?? value.value ?? value.date;
    return toDate(nested);
  }

  return null;
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return "";
}

function parseReminder(item: unknown): Reminder | null {
  if (!isRecord(item)) return null;

  const id =
    toStringValue(item.id) ||
    toStringValue(item.identifier) ||
    toStringValue(item.uuid) ||
    toStringValue(item.reminderId) ||
    toStringValue(item.uid);

  const title =
    toStringValue(item.title) ||
    toStringValue(item.name) ||
    toStringValue(item.summary) ||
    toStringValue(item.text) ||
    "(untitled)";

  const listName =
    toStringValue(item.list) ||
    toStringValue(item.listName) ||
    toStringValue(item.calendar) ||
    toStringValue(item.group) ||
    "Reminders";

  const dueAt =
    toDate(item.dueAt) ||
    toDate(item.dueDate) ||
    toDate(item.due) ||
    toDate(item.dueISO) ||
    toDate(item.date) ||
    toDate(item.deadline) ||
    toDate(item.scheduledDate);

  if (!dueAt) return null;

  const stableId = id || `${title}|${dueAt.toISOString()}|${listName}`;
  return { id: stableId, title, listName, dueAt };
}

function parseReminderArray(raw: string): Reminder[] {
  const text = raw.trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map(parseReminder).filter((v): v is Reminder => !!v);
    if (!isRecord(parsed)) return [];

    const container =
      (Array.isArray(parsed.reminders) && parsed.reminders) ||
      (Array.isArray(parsed.items) && parsed.items) ||
      (Array.isArray(parsed.data) && parsed.data) ||
      (Array.isArray(parsed.results) && parsed.results) ||
      [];

    return container.map(parseReminder).filter((v): v is Reminder => !!v);
  } catch {
    return [];
  }
}

function readState(): Required<State> {
  const loaded = readJsonFile<State>(STATE_PATH) ?? {};
  return {
    sent: isRecord(loaded.sent) ? (loaded.sent as Record<string, string>) : {},
    meta: isRecord(loaded.meta) ? (loaded.meta as { permissionAlertSentAt?: string; commandErrorAlertSentAt?: string }) : {},
    updatedAt: typeof loaded.updatedAt === "string" ? loaded.updatedAt : "",
  };
}

function writeState(state: Required<State>): void {
  state.updatedAt = new Date().toISOString();
  writeJsonFileAtomic(STATE_PATH, state, 2);
}

function runRemindctl(filter: "upcoming" | "overdue"): { reminders: Reminder[]; denied: boolean; error: string } {
  const run = spawnSync(
    "remindctl",
    ["show", filter, "--json", "--no-input", "--no-color"],
    { encoding: "utf8" },
  );

  const stdout = (run.stdout ?? "").trim();
  const stderr = (run.stderr ?? "").trim();
  const merged = `${stdout}\n${stderr}`.trim();
  const denied = /reminders access denied|run `remindctl authorize`|not determined/i.test(merged);

  if (denied) return { reminders: [], denied: true, error: merged || "Reminders access denied" };
  if (run.status !== 0) return { reminders: [], denied: false, error: merged || `remindctl exited ${run.status ?? 1}` };

  return { reminders: parseReminderArray(stdout), denied: false, error: "" };
}

function shouldEmitCooldownAlert(isoTimestamp: string | undefined, cooldownHours: number): boolean {
  if (!isoTimestamp) return true;
  const prev = new Date(isoTimestamp);
  if (Number.isNaN(prev.getTime())) return true;
  return Date.now() - prev.getTime() >= cooldownHours * 60 * 60 * 1000;
}

function truncateTitle(value: string, max = 70): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function formatEt(date: Date): string {
  return date.toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function minutesDiff(target: Date, now: Date): number {
  return Math.round((target.getTime() - now.getTime()) / 60000);
}

function overdueAgeLabel(target: Date, now: Date): string {
  const mins = Math.max(1, Math.round((now.getTime() - target.getTime()) / 60000));
  if (mins < 60) return `${mins}m overdue`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h overdue`;
  const days = Math.round(hours / 24);
  return `${days}d overdue`;
}

function todayEtBucket(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: TZ });
}

function pruneState(sent: Record<string, string>): Record<string, string> {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const out: Record<string, string> = {};
  for (const [key, iso] of Object.entries(sent)) {
    const ts = new Date(iso).getTime();
    if (Number.isNaN(ts) || ts >= cutoff) out[key] = iso;
  }
  return out;
}

function main(): number {
  const now = new Date();
  const state = readState();
  state.sent = pruneState(state.sent);

  const upcoming = runRemindctl("upcoming");
  const overdue = runRemindctl("overdue");

  if (upcoming.denied || overdue.denied) {
    if (shouldEmitCooldownAlert(state.meta.permissionAlertSentAt, ALERT_COOLDOWN_HOURS)) {
      state.meta.permissionAlertSentAt = now.toISOString();
      writeState(state);
      console.log("⚠️ Apple Reminders access is not granted. Allow Terminal/OpenClaw in System Settings > Privacy & Security > Reminders, then run `remindctl authorize`.");
      return 0;
    }
    writeState(state);
    console.log("NO_REPLY");
    return 0;
  }

  if (upcoming.error || overdue.error) {
    if (shouldEmitCooldownAlert(state.meta.commandErrorAlertSentAt, ALERT_COOLDOWN_HOURS)) {
      state.meta.commandErrorAlertSentAt = now.toISOString();
      writeState(state);
      console.log(`⚠️ Apple Reminders monitor failed: ${(upcoming.error || overdue.error).split("\n")[0]}`);
      return 0;
    }
    writeState(state);
    console.log("NO_REPLY");
    return 0;
  }

  const soonLimit = now.getTime() + SOON_WINDOW_MINUTES * 60 * 1000;
  const soon = upcoming.reminders
    .filter((item) => item.dueAt.getTime() >= now.getTime() && item.dueAt.getTime() <= soonLimit)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());

  const overdueItems = overdue.reminders
    .filter((item) => item.dueAt.getTime() < now.getTime())
    .sort((a, b) => b.dueAt.getTime() - a.dueAt.getTime());

  const etDayBucket = todayEtBucket(now);
  const lines: string[] = [];
  let remaining = MAX_LINES;

  for (const item of soon) {
    if (remaining <= 0) break;
    const key = `soon|${item.id}|${Math.floor(item.dueAt.getTime() / 60000)}`;
    if (state.sent[key]) continue;
    state.sent[key] = now.toISOString();
    const mins = Math.max(0, minutesDiff(item.dueAt, now));
    lines.push(`• ${truncateTitle(item.title)} in ${mins}m (${item.listName})`);
    remaining -= 1;
  }

  for (const item of overdueItems) {
    if (remaining <= 0) break;
    const key = `overdue|${item.id}|${etDayBucket}`;
    if (state.sent[key]) continue;
    state.sent[key] = now.toISOString();
    lines.push(`• OVERDUE ${truncateTitle(item.title)} (${overdueAgeLabel(item.dueAt, now)})`);
    remaining -= 1;
  }

  writeState(state);

  if (!lines.length) {
    console.log("NO_REPLY");
    return 0;
  }

  const firstSoon = soon.find((item) => {
    const key = `soon|${item.id}|${Math.floor(item.dueAt.getTime() / 60000)}`;
    return !!state.sent[key];
  });
  const nextDueLabel = firstSoon ? formatEt(firstSoon.dueAt) : "n/a";
  console.log(["⏰ Apple Reminders - Due Alerts", ...lines, `Next due: ${nextDueLabel} ET`].join("\n"));
  return 0;
}

process.exit(main());
