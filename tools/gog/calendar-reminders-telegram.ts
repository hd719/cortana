#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../lib/json-file.js";
import { sourceRepoRoot } from "../lib/paths.js";
import { runCalendarEventsJson } from "./calendar-events-json.js";

type CalendarDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

export type CalendarEvent = {
  id?: string;
  summary?: string;
  status?: string;
  start?: CalendarDateTime;
};

export type DueCalendarReminder = {
  key: string;
  title: string;
  start: Date;
  minutesUntilStart: number;
  windowMinutes: 30 | 60;
};

type RunOptions = {
  now?: Date;
  statePath?: string;
  eventsJson?: string;
  dryRun?: boolean;
  sendTelegram?: (message: string) => void;
};

type EventsPayload = {
  events?: CalendarEvent[];
};

const TZ = "America/New_York";
const ACCOUNT = "hameldesai3@gmail.com";
const CALENDAR_ID = "60e1d0b7ca7586249ee94341d65076f28d9b9f3ec67d89b0709371c0ff82d517@group.calendar.google.com";
const DEFAULT_TARGET = "8171372724";
const DEFAULT_ACCOUNT_ID = "monitor";
const DEFAULT_STATE_PATH = path.join(sourceRepoRoot(), "memory", "calendar-reminders-sent.json");

function todayEt(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: TZ });
}

function formatTimeEt(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function loadSentKeys(statePath: string): Set<string> {
  const raw = readJsonFile<unknown>(statePath);
  if (Array.isArray(raw)) return new Set(raw.filter((entry): entry is string => typeof entry === "string"));
  if (raw && typeof raw === "object" && Array.isArray((raw as { sent?: unknown }).sent)) {
    return new Set((raw as { sent: unknown[] }).sent.filter((entry): entry is string => typeof entry === "string"));
  }
  return new Set();
}

function writeSentKeys(statePath: string, sent: Set<string>): void {
  writeJsonFileAtomic(statePath, [...sent].sort(), 2);
}

function pruneSentKeys(sent: Set<string>, now: Date): Set<string> {
  const cutoff = now.getTime() - 14 * 24 * 60 * 60 * 1000;
  return new Set([...sent].filter((key) => {
    const ts = Date.parse(key.split("|").at(-1) ?? "");
    return Number.isNaN(ts) || ts >= cutoff;
  }));
}

function reminderWindow(minutesUntilStart: number): 30 | 60 | null {
  if (minutesUntilStart >= 55 && minutesUntilStart <= 65) return 60;
  if (minutesUntilStart >= 25 && minutesUntilStart <= 35) return 30;
  return null;
}

export function parseEventsJson(raw: string): CalendarEvent[] {
  const parsed = JSON.parse(raw) as EventsPayload;
  return Array.isArray(parsed.events) ? parsed.events : [];
}

export function findDueCalendarReminders(events: CalendarEvent[], sent: Set<string>, now = new Date()): DueCalendarReminder[] {
  const today = todayEt(now);
  const due: DueCalendarReminder[] = [];

  for (const event of events) {
    if (event.status === "cancelled") continue;
    const dateTime = event.start?.dateTime;
    if (!dateTime) continue;

    const start = new Date(dateTime);
    if (Number.isNaN(start.getTime())) continue;
    if (todayEt(start) !== today) continue;

    const minutesUntilStart = Math.round((start.getTime() - now.getTime()) / 60000);
    const windowMinutes = reminderWindow(minutesUntilStart);
    if (!windowMinutes) continue;

    const title = (event.summary || "(No title)").trim();
    const key = `${event.id || title}|${dateTime}|${windowMinutes}|${start.toISOString()}`;
    if (sent.has(key)) continue;

    due.push({ key, title, start, minutesUntilStart, windowMinutes });
  }

  return due.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function renderCalendarReminderMessage(reminders: DueCalendarReminder[]): string {
  const body = reminders.map((reminder) => [
    `⏰ ${reminder.title} in ${reminder.minutesUntilStart} minutes`,
    `When: ${formatTimeEt(reminder.start)} ET`,
  ].join("\n"));

  return ["⏰ Calendar - Event Reminder", ...body].join("\n\n");
}

function fetchCalendarEventsJson(): string | null {
  const result = runCalendarEventsJson([
    "--account",
    ACCOUNT,
    "calendar",
    "events",
    CALENDAR_ID,
    "--from",
    "today",
    "--to",
    "tomorrow",
    "--json",
  ]);

  if ((result.status ?? 1) !== 0) return null;
  return result.stdout || "{\"events\":[]}";
}

function sendTelegram(message: string): void {
  const proc = spawnSync("openclaw", [
    "message",
    "send",
    "--channel",
    "telegram",
    "--account",
    process.env.CALENDAR_REMINDERS_TELEGRAM_ACCOUNT ?? DEFAULT_ACCOUNT_ID,
    "--target",
    process.env.CALENDAR_REMINDERS_TELEGRAM_TARGET ?? DEFAULT_TARGET,
    "--message",
    message,
    "--json",
  ], {
    encoding: "utf8",
    timeout: Number(process.env.CALENDAR_REMINDERS_SEND_TIMEOUT_MS ?? "30000"),
  });

  if ((proc.status ?? 1) !== 0) {
    const details = (proc.stderr || proc.stdout || "").trim();
    throw new Error(`calendar reminder Telegram send failed: ${details || `exit ${proc.status ?? 1}`}`);
  }
}

export function runCalendarReminders(options: RunOptions = {}): string {
  const now = options.now ?? new Date(process.env.CALENDAR_REMINDERS_NOW ?? Date.now());
  const statePath = options.statePath ?? process.env.CALENDAR_REMINDERS_STATE_PATH ?? DEFAULT_STATE_PATH;
  const eventsJson = options.eventsJson ?? fetchCalendarEventsJson();
  if (!eventsJson) return "NO_REPLY";

  const sent = pruneSentKeys(loadSentKeys(statePath), now);
  const reminders = findDueCalendarReminders(parseEventsJson(eventsJson), sent, now);
  if (reminders.length === 0) {
    writeSentKeys(statePath, sent);
    return "NO_REPLY";
  }

  const message = renderCalendarReminderMessage(reminders);
  if (options.dryRun || process.env.CALENDAR_REMINDERS_DRY_RUN === "1") return message;

  (options.sendTelegram ?? sendTelegram)(message);
  for (const reminder of reminders) sent.add(reminder.key);
  writeSentKeys(statePath, sent);
  return "NO_REPLY";
}

function main(): void {
  try {
    process.stdout.write(`${runCalendarReminders()}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
