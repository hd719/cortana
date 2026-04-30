#!/usr/bin/env -S npx tsx
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGogWithEnv } from "../gog/gog-with-env.js";

export type EarningsEntry = {
  symbol: string;
  earnings_date: string | null;
  days_until: number | null;
  confirmed: boolean;
  source?: string;
};

type CalendarEvent = {
  summary?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
};

const CALENDAR_NAME = "Clawdbot-Calendar";
const DEFAULT_WINDOW_HOURS = 48;
const EARNINGS_WINDOW_DAYS = 2;
const CHECK_EARNINGS_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "check-earnings.sh");

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function extractSymbolFromSummary(summary: string): string | null {
  const trimmed = summary.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/(?:📊\s*)?([A-Z][A-Z0-9.-]{0,9})\s+Earnings\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

export function eventDate(event: CalendarEvent): string | null {
  const dateTime = event.start?.dateTime;
  if (dateTime) return dateTime.slice(0, 10);
  const date = event.start?.date;
  return date ? date.slice(0, 10) : null;
}

export function computeDaysUntil(date: string, now = new Date()): number | null {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const target = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

export function mergeUpcomingEarnings(
  holdings: EarningsEntry[],
  calendarEvents: CalendarEvent[],
  now = new Date(),
): EarningsEntry[] {
  const merged = new Map<string, EarningsEntry>();

  for (const entry of holdings) {
    if (!entry.symbol) continue;
    merged.set(entry.symbol.toUpperCase(), {
      symbol: entry.symbol.toUpperCase(),
      earnings_date: entry.earnings_date ?? null,
      days_until: entry.days_until ?? (entry.earnings_date ? computeDaysUntil(entry.earnings_date, now) : null),
      confirmed: Boolean(entry.confirmed),
      source: entry.source ?? "holdings",
    });
  }

  for (const event of calendarEvents) {
    const symbol = extractSymbolFromSummary(event.summary ?? "");
    const earningsDate = eventDate(event);
    if (!symbol || !earningsDate) continue;

    const daysUntil = computeDaysUntil(earningsDate, now);
    if (daysUntil == null || daysUntil < 0 || daysUntil > EARNINGS_WINDOW_DAYS) continue;

    const existing = merged.get(symbol);
    if (!existing || existing.earnings_date == null || (existing.days_until != null && existing.days_until > EARNINGS_WINDOW_DAYS)) {
      merged.set(symbol, {
        symbol,
        earnings_date: earningsDate,
        days_until: daysUntil,
        confirmed: true,
        source: "calendar",
      });
      continue;
    }

    if (existing.earnings_date === earningsDate) {
      existing.confirmed = existing.confirmed || true;
      existing.source = existing.source === "holdings" ? "holdings+calendar" : existing.source;
    }
  }

  return [...merged.values()]
    .filter((entry) => entry.earnings_date != null && entry.days_until != null && entry.days_until >= 0 && entry.days_until <= EARNINGS_WINDOW_DAYS)
    .sort((a, b) => {
      const dayDelta = (a.days_until ?? 999) - (b.days_until ?? 999);
      return dayDelta !== 0 ? dayDelta : a.symbol.localeCompare(b.symbol);
    });
}

export function resolveCheckEarningsScriptPath(): string {
  return CHECK_EARNINGS_SCRIPT;
}

function runCheckEarnings(): EarningsEntry[] {
  const result = spawnSync("bash", [CHECK_EARNINGS_SCRIPT], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "check-earnings.sh failed");
  }

  return parseJson<EarningsEntry[]>(result.stdout || "[]", []);
}

function runCalendarList(windowHours = DEFAULT_WINDOW_HOURS): CalendarEvent[] {
  const end = new Date(Date.now() + windowHours * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = runGogWithEnv(["cal", "list", CALENDAR_NAME, "--from", "today", "--to", end, "--json", "--no-input"]);

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "calendar list failed");
  }

  const parsed = parseJson<{ events?: CalendarEvent[] }>(result.stdout || "{}", {});
  return Array.isArray(parsed.events) ? parsed.events : [];
}

export function main(): void {
  const holdings = runCheckEarnings();
  const calendarEvents = runCalendarList();
  const merged = mergeUpcomingEarnings(holdings, calendarEvents, new Date());
  process.stdout.write(`${JSON.stringify(merged)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
