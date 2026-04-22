import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractSymbolFromSummary, mergeUpcomingEarnings } from "../../tools/earnings/upcoming-holdings-earnings.ts";

describe("upcoming holdings earnings reconciliation", () => {
  it("extracts the ticker from calendar earnings titles", () => {
    expect(extractSymbolFromSummary("📊 BA Earnings (Q1 2026)")).toBe("BA");
    expect(extractSymbolFromSummary("BA Earnings")).toBe("BA");
    expect(extractSymbolFromSummary("Something else")).toBeNull();
  });

  it("falls back to existing calendar earnings events when holdings data is empty", () => {
    const merged = mergeUpcomingEarnings(
      [],
      [
        {
          summary: "📊 BA Earnings (Q1 2026)",
          start: { dateTime: "2026-04-22T09:00:00-04:00", timeZone: "America/New_York" },
          end: { dateTime: "2026-04-22T09:30:00-04:00", timeZone: "America/New_York" },
        },
      ],
      new Date("2026-04-22T11:04:00Z"),
    );

    expect(merged).toEqual([
      {
        symbol: "BA",
        earnings_date: "2026-04-22",
        days_until: 0,
        confirmed: true,
        source: "calendar",
      },
    ]);
  });

  it("keeps holdings entries when they already match the calendar event", () => {
    const merged = mergeUpcomingEarnings(
      [{ symbol: "BA", earnings_date: "2026-04-22", days_until: 0, confirmed: false, source: "holdings" }],
      [{ summary: "📊 BA Earnings (Q1 2026)", start: { dateTime: "2026-04-22T09:00:00-04:00" } }],
      new Date("2026-04-22T11:04:00Z"),
    );

    expect(merged).toEqual([
      {
        symbol: "BA",
        earnings_date: "2026-04-22",
        days_until: 0,
        confirmed: true,
        source: "holdings+calendar",
      },
    ]);
  });
});

describe("earnings alert cron wiring", () => {
  it("points the alert prompt at the reconciled script", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; payload?: { message?: string } }>;
    };

    const job = json.jobs.find((entry) => entry.id === "fd0ee16f-2259-4759-963f-85d5119447eb");
    const message = String(job?.payload?.message ?? "");

    expect(message).toContain("/Users/hd/Developer/cortana/tools/earnings/upcoming-holdings-earnings.ts");
    expect(message).toContain("merges holdings data with existing Clawdbot-Calendar earnings events");
    expect(message).not.toContain("/Users/hd/Developer/cortana/tools/earnings/check-earnings.sh");
  });
});
