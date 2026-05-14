import { describe, expect, it } from "vitest";
import { buildBootstrapContext, buildOperatorContext, parseCalendarEvents } from "../../tools/context/main-operator-context.ts";

describe("parseCalendarEvents", () => {
  it("sorts and deduplicates calendar labels", () => {
    const lines = parseCalendarEvents([
      { summary: "Design review", start: { dateTime: "2026-04-06T14:00:00.000Z" } },
      { summary: "Standup", start: { dateTime: "2026-04-06T13:00:00.000Z" } },
      { summary: "Standup", start: { dateTime: "2026-04-06T13:00:00.000Z" } },
      { summary: "Tax day", start: { date: "2026-04-06" } },
    ]);

    expect(lines).toEqual([
      "All day - Tax day",
      "9:00 AM - Standup",
      "10:00 AM - Design review",
    ]);
  });
});

describe("buildOperatorContext", () => {
  it("renders a compact live-context summary", () => {
    const text = buildOperatorContext({
      generatedAt: "Mon, Apr 6, 8:00 AM",
      schedule: ["9:00 AM - Standup"],
      reminders: ["Submit quiz"],
      followUps: {
        items: [{ title: "Fix degraded runtime", system: "mission-control", severity: "high", due_at: "Apr 06 05:00 PM" }],
        openCount: 1,
      },
      warnings: [],
    });

    expect(text).toContain("Generated: Mon, Apr 6, 8:00 AM");
    expect(text).toContain("Schedule:");
    expect(text).toContain("- 9:00 AM - Standup");
    expect(text).toContain("Reminders:");
    expect(text).toContain("- Submit quiz");
    expect(text).toContain("Operational Follow-ups:");
    expect(text).toContain("- [high] Fix degraded runtime (due Apr 06 05:00 PM)");
    expect(text).toContain("Open human-required items: 1");
  });
});

describe("buildBootstrapContext", () => {
  it("renders a compact bootstrap snapshot", () => {
    const text = buildBootstrapContext({
      generatedAt: "Mon, Apr 6, 8:00 AM",
      schedule: ["9:00 AM - Standup"],
      reminders: ["Submit quiz"],
      followUps: {
        items: [{ title: "Fix degraded runtime", system: "mission-control", severity: "high", due_at: "Apr 06 05:00 PM" }],
        openCount: 1,
      },
      warnings: ["calendar:primary:slow"],
    });

    expect(text).toContain("# BOOTSTRAP.md");
    expect(text).toContain("Generated: Mon, Apr 6, 8:00 AM");
    expect(text).toContain("Schedule:");
    expect(text).toContain("- 9:00 AM - Standup");
    expect(text).toContain("Reminders:");
    expect(text).toContain("- Submit quiz");
    expect(text).toContain("Operational Follow-ups:");
    expect(text).toContain("- [high] Fix degraded runtime (due Apr 06 05:00 PM)");
    expect(text).toContain("- Open count: 1");
    expect(text).toContain("Warnings:");
  });
});
