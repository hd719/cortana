import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findDueCalendarReminders,
  renderCalendarReminderMessage,
  runCalendarReminders,
  type CalendarEvent,
} from "../../tools/gog/calendar-reminders-telegram.ts";

const now = new Date("2026-05-20T08:00:00-04:00");

function event(id: string, start: string, summary = "Work"): CalendarEvent {
  return {
    id,
    status: "confirmed",
    summary,
    start: { dateTime: start, timeZone: "America/New_York" },
  };
}

function tempStatePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "calendar-reminders-")), "sent.json");
}

describe("calendar reminders Telegram cron", () => {
  it("selects only today's events inside the 60m or 30m reminder windows", () => {
    const due = findDueCalendarReminders([
      event("due-60", "2026-05-20T09:00:00-04:00", "Morning Readiness"),
      event("due-30", "2026-05-20T08:30:00-04:00", "School run"),
      event("too-soon", "2026-05-20T08:20:00-04:00"),
      event("tomorrow", "2026-05-21T09:00:00-04:00"),
      { id: "all-day", summary: "All day", start: { date: "2026-05-20" } },
    ], new Set(), now);

    expect(due.map((reminder) => [reminder.title, reminder.windowMinutes])).toEqual([
      ["School run", 30],
      ["Morning Readiness", 60],
    ]);
  });

  it("skips reminders already written to the dedupe state", () => {
    const existing = findDueCalendarReminders([event("due", "2026-05-20T09:00:00-04:00")], new Set(), now)[0];
    const due = findDueCalendarReminders([event("due", "2026-05-20T09:00:00-04:00")], new Set([existing.key]), now);

    expect(due).toEqual([]);
  });

  it("sends a due reminder once and records the dedupe key only after send succeeds", () => {
    const statePath = tempStatePath();
    const sends: string[] = [];
    const output = runCalendarReminders({
      now,
      statePath,
      eventsJson: JSON.stringify({ events: [event("due", "2026-05-20T09:00:00-04:00", "Work")] }),
      sendTelegram: (message) => sends.push(message),
    });

    expect(output).toBe("NO_REPLY");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("⏰ Work in 60 minutes");
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toHaveLength(1);

    const secondOutput = runCalendarReminders({
      now,
      statePath,
      eventsJson: JSON.stringify({ events: [event("due", "2026-05-20T09:00:00-04:00", "Work")] }),
      sendTelegram: (message) => sends.push(message),
    });

    expect(secondOutput).toBe("NO_REPLY");
    expect(sends).toHaveLength(1);
  });

  it("keeps calendar read failures and no-due runs quiet", () => {
    const statePath = tempStatePath();

    expect(runCalendarReminders({ now, statePath, eventsJson: "", sendTelegram: () => { throw new Error("should not send"); } })).toBe("NO_REPLY");
    expect(runCalendarReminders({
      now,
      statePath,
      eventsJson: JSON.stringify({ events: [event("later", "2026-05-20T11:00:00-04:00")] }),
      sendTelegram: () => { throw new Error("should not send"); },
    })).toBe("NO_REPLY");
  });

  it("renders the operator-facing Telegram shape", () => {
    const reminders = findDueCalendarReminders([event("due", "2026-05-20T08:30:00-04:00", "Morning Readiness")], new Set(), now);

    expect(renderCalendarReminderMessage(reminders)).toBe([
      "⏰ Calendar - Event Reminder",
      "",
      "⏰ Morning Readiness in 30 minutes",
      "When: 8:30 AM ET",
    ].join("\n"));
  });
});
