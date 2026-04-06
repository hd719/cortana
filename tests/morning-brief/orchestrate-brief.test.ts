import { describe, expect, it } from "vitest";
import { buildBrief, parseCalendarEvents } from "../../tools/morning-brief/orchestrate-brief.ts";

describe("parseCalendarEvents", () => {
  it("sorts, deduplicates, and formats schedule lines", () => {
    const lines = parseCalendarEvents([
      {
        summary: "Design review",
        start: { dateTime: "2026-04-06T14:00:00.000Z" },
      },
      {
        summary: "Standup",
        start: { dateTime: "2026-04-06T13:00:00.000Z" },
      },
      {
        summary: "Standup",
        start: { dateTime: "2026-04-06T13:00:00.000Z" },
      },
      {
        summary: "Tax day",
        start: { date: "2026-04-06" },
      },
    ]);

    expect(lines).toEqual([
      "All day - Tax day",
      "9:00 AM - Standup",
      "10:00 AM - Design review",
    ]);
  });
});

describe("buildBrief", () => {
  it("builds a mobile-friendly brief around schedule and reminders without generic priorities", () => {
    const brief = buildBrief({
      weather: "Warren+NJ: 54F and Sunny",
      schedule: ["9:00 AM - Standup", "1:00 PM - EM-605"],
      reminders: ["Submit quiz", "Call pharmacy"],
      specialists: [
        {
          sessionKey: "agent:researcher:main",
          ok: true,
          text: "- CPI data due this week\n- Tech: major outage at cloud provider",
        },
        {
          sessionKey: "agent:oracle:main",
          ok: true,
          text: "- PREMARKET\n- Watch rates after jobs data",
        },
      ],
    });

    expect(brief).toContain("☀️ Brief - Morning Brief");
    expect(brief).toContain("Schedule:");
    expect(brief).toContain("Apple Reminders:");
    expect(brief).toContain("Weather:");
    expect(brief).toContain("News:");
    expect(brief).toContain("Markets:");
    expect(brief).toContain("- 9:00 AM - Standup");
    expect(brief).toContain("- Submit quiz");
    expect(brief).not.toContain("Top 3 priorities");
    expect(brief).not.toContain("career-advancing task");
  });
});
