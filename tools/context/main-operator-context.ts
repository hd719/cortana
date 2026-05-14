#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { queryJson } from "../lib/db.js";

type CalendarEvent = {
  summary?: string;
  status?: string;
  start?: {
    date?: string;
    dateTime?: string;
  };
};

type ReminderItem = {
  title?: string;
  isCompleted?: boolean;
  listName?: string;
};

type FollowUpItem = {
  title: string;
  system: string | null;
  severity: string | null;
  due_at: string | null;
};

type OperatorContext = {
  generatedAt: string;
  schedule: string[];
  reminders: string[];
  followUps: {
    items: FollowUpItem[];
    openCount: number;
  };
  warnings: string[];
};

const CALENDAR_HELPER = "/Users/hd/Developer/cortana/tools/gog/calendar-events-json.ts";
const TIME_ZONE = "America/New_York";
const REMINDER_LIST = "Cortana";

function safeJsonParse<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function run(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const proc = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    ok: (proc.status ?? 1) === 0,
    stdout: (proc.stdout ?? "").trim(),
    stderr: (proc.stderr ?? "").trim(),
  };
}

function eventSortKey(event: CalendarEvent): number {
  const dateTime = event.start?.dateTime;
  if (dateTime) {
    const ts = Date.parse(dateTime);
    if (Number.isFinite(ts)) return ts;
  }
  const allDayDate = event.start?.date;
  if (allDayDate) {
    const ts = Date.parse(allDayDate);
    if (Number.isFinite(ts)) return ts;
  }
  return Number.MAX_SAFE_INTEGER;
}

function formatEventLabel(event: CalendarEvent): string | null {
  const summary = (event.summary ?? "Untitled").trim();
  if (!summary || event.status === "cancelled") return null;

  if (event.start?.date) return `All day - ${summary}`;
  if (event.start?.dateTime) {
    const dt = new Date(event.start.dateTime);
    if (!Number.isNaN(dt.getTime())) {
      const label = new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(dt);
      return `${label} - ${summary}`;
    }
  }

  return summary;
}

export function parseCalendarEvents(events: CalendarEvent[]): string[] {
  const seen = new Set<string>();
  return events
    .filter((event) => event && event.status !== "cancelled")
    .sort((a, b) => eventSortKey(a) - eventSortKey(b))
    .map((event) => ({
      key: `${event.start?.dateTime ?? event.start?.date ?? "na"}|${(event.summary ?? "").trim()}`,
      label: formatEventLabel(event),
    }))
    .filter((entry) => Boolean(entry.label))
    .filter((entry) => {
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    })
    .map((entry) => entry.label as string)
    .slice(0, 6);
}

function fetchCalendarFrom(calendarId: string): { events: CalendarEvent[]; warning?: string } {
  const out = run("npx", [
    "tsx",
    CALENDAR_HELPER,
    "--account",
    "hameldesai3@gmail.com",
    "cal",
    "list",
    calendarId,
    "--from",
    "today",
    "--to",
    "today",
    "--json",
  ]);

  if (!out.ok) {
    return { events: [], warning: `calendar:${calendarId}:${out.stderr || out.stdout || "unavailable"}` };
  }

  const parsed = safeJsonParse<{ events?: CalendarEvent[] }>(out.stdout);
  return { events: Array.isArray(parsed?.events) ? parsed.events : [] };
}

function fetchReminders(): { reminders: string[]; warning?: string } {
  const out = run("remindctl", ["all", "--json"]);
  if (!out.ok) {
    return { reminders: [], warning: `reminders:${out.stderr || out.stdout || "unavailable"}` };
  }

  const parsed = safeJsonParse<ReminderItem[]>(out.stdout);
  if (!Array.isArray(parsed)) {
    return { reminders: [], warning: "reminders:invalid-json" };
  }

  const reminders = parsed
    .filter((item) => item && item.isCompleted === false)
    .filter((item) => (item.listName ?? "") === REMINDER_LIST)
    .map((item) => (item.title ?? "").trim())
    .filter(Boolean)
    .slice(0, 5);

  return { reminders };
}

function fetchFollowUps(): OperatorContext["followUps"] {
  const rows = queryJson<OperatorContext["followUps"]>(`
    WITH followup_rows AS (
      SELECT
        title,
        system,
        severity,
        CASE
          WHEN due_at IS NULL THEN NULL
          ELSE to_char(due_at AT TIME ZONE '${TIME_ZONE}', 'Mon DD HH12:MI AM')
        END AS due_at
      FROM cortana_human_required_actions
      WHERE status = 'open'
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        due_at ASC NULLS LAST,
        last_seen_at DESC,
        title ASC
      LIMIT 5
    )
    SELECT COALESCE(json_build_object(
      'items', COALESCE((SELECT json_agg(followup_rows) FROM followup_rows), '[]'::json),
      'openCount', COALESCE((SELECT COUNT(*) FROM cortana_human_required_actions WHERE status = 'open'), 0)
    )::text, '{}'::text) AS context_json;
  `);

  const parsed = rows[0];
  return {
    items: Array.isArray(parsed?.items) ? parsed.items : [],
    openCount: Number(parsed?.openCount ?? 0),
  };
}

export function buildOperatorContext(ctx: OperatorContext): string {
  const lines = [
    `Generated: ${ctx.generatedAt}`,
    "Schedule:",
    ...(ctx.schedule.length ? ctx.schedule.map((line) => `- ${line}`) : ["- No calendar blocks today."]),
    "Reminders:",
    ...(ctx.reminders.length ? ctx.reminders.map((line) => `- ${line}`) : ["- No open Cortana reminders."]),
    "Operational Follow-ups:",
    ...(ctx.followUps.items.length
      ? ctx.followUps.items.map((item) => `- [${item.severity ?? "attention"}] ${item.title}${item.due_at ? ` (due ${item.due_at})` : ""}`)
      : ["- No open human-required items."]),
    `Open human-required items: ${ctx.followUps.openCount}`,
  ];

  if (ctx.warnings.length) {
    lines.push("Warnings:");
    lines.push(...ctx.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

export function buildBootstrapContext(ctx: OperatorContext): string {
  const lines = [
    "# BOOTSTRAP.md",
    "Use this current-state snapshot for reset, planning, and prioritization replies.",
    `Generated: ${ctx.generatedAt}`,
    "",
    "Schedule:",
    ...(ctx.schedule.length ? ctx.schedule.slice(0, 4).map((line) => `- ${line}`) : ["- No calendar blocks today."]),
    "",
    "Reminders:",
    ...(ctx.reminders.length ? ctx.reminders.slice(0, 4).map((line) => `- ${line}`) : ["- No open Cortana reminders."]),
    "",
    "Operational Follow-ups:",
  ];

  if (ctx.followUps.items.length) {
    lines.push(...ctx.followUps.items.slice(0, 3).map((item) => `- [${item.severity ?? "attention"}] ${item.title}${item.due_at ? ` (due ${item.due_at})` : ""}`));
  } else {
    lines.push("- No open human-required items.");
  }

  lines.push(`- Open count: ${ctx.followUps.openCount}`);

  if (ctx.warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    lines.push(...ctx.warnings.slice(0, 3).map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

export function collectOperatorContext(): OperatorContext {
  const warnings: string[] = [];

  const primary = fetchCalendarFrom("primary");
  const clawdbot = fetchCalendarFrom("Clawdbot-Calendar");
  if (primary.warning) warnings.push(primary.warning);
  if (clawdbot.warning) warnings.push(clawdbot.warning);

  const reminderState = fetchReminders();
  if (reminderState.warning) warnings.push(reminderState.warning);

  let followUps: OperatorContext["followUps"] = { items: [], openCount: 0 };
  try {
    followUps = fetchFollowUps();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    warnings.push(`followups:${msg}`);
  }

  return {
    generatedAt: new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date()),
    schedule: parseCalendarEvents([...primary.events, ...clawdbot.events]),
    reminders: reminderState.reminders,
    followUps,
    warnings,
  };
}

function main() {
  const json = process.argv.includes("--json");
  const bootstrap = process.argv.includes("--bootstrap");
  const context = collectOperatorContext();
  if (json) {
    process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
    return;
  }
  if (bootstrap) {
    process.stdout.write(`${buildBootstrapContext(context)}\n`);
    return;
  }
  process.stdout.write(`${buildOperatorContext(context)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
