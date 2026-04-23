import { describe, expect, it } from "vitest";
import { buildDigest, cronWindow } from "../../tools/monitoring/daily-cron-digest.ts";

describe("daily-cron-digest", () => {
  it("treats the digest job as running now instead of expected-but-missing", () => {
    const now = new Date("2026-04-22T21:12:30-04:00");
    const output = buildDigest({
      now,
      selfJobId: "digest-job",
      heartbeatStatus: "healthy",
      health: {
        errorCount: 0,
        cronFailCount: 0,
        warningCount: 2,
        criticalCount: 1,
      },
      jobs: [
        {
          id: "digest-job",
          name: "🔍 Daily System Health Summary",
          enabled: true,
          schedule: {
            kind: "cron",
            expr: "12 21 * * *",
            tz: "America/New_York",
          },
          state: {
            nextRunAtMs: Date.parse("2026-04-23T01:12:00.000Z"),
            consecutiveErrors: 0,
          },
        },
      ],
      latestEntriesByJobId: {
        "digest-job": {
          action: "started",
          runAtMs: Date.parse("2026-04-23T01:12:00.000Z"),
        },
      },
      latestFinishedByJobId: {
        "digest-job": null,
      },
    });

    expect(output).toContain("⏳ 🔍 Daily System Health Summary — running now");
    expect(output).not.toContain("Expected but missing");
  });

  it("prefers fresher finished run history over stale job state", () => {
    const now = new Date("2026-04-22T21:12:30-04:00");
    const output = buildDigest({
      now,
      selfJobId: "digest-job",
      heartbeatStatus: "healthy",
      health: {
        errorCount: 0,
        cronFailCount: 0,
        warningCount: 0,
        criticalCount: 0,
      },
      jobs: [
        {
          id: "memory",
          name: "🧠 Memory Consolidation",
          enabled: true,
          schedule: {
            kind: "cron",
            expr: "12 3 * * *",
            tz: "America/New_York",
          },
          state: {
            lastRunAtMs: Date.parse("2026-04-21T07:12:00.000Z"),
            lastStatus: "ok",
            lastDurationMs: 70426,
            consecutiveErrors: 0,
          },
        },
      ],
      latestEntriesByJobId: {
        memory: {
          action: "finished",
          runAtMs: Date.parse("2026-04-22T07:12:00.026Z"),
          status: "error",
          durationMs: 300052,
        },
      },
      latestFinishedByJobId: {
        memory: {
          action: "finished",
          runAtMs: Date.parse("2026-04-22T07:12:00.026Z"),
          status: "error",
          durationMs: 300052,
        },
      },
    });

    expect(output).toContain("❌ 🧠 Memory Consolidation — failed (300.1s)");
    expect(output).not.toContain("No failed finished runs today");
  });

  it("correctly distinguishes weekday-only jobs from missing jobs on Sunday", () => {
    const sundayEvening = new Date("2026-04-19T21:00:00-04:00");
    expect(
      cronWindow("0 11,15 * * 1-5", sundayEvening, "America/New_York"),
    ).toEqual({
      scheduledToday: false,
      dueByNow: false,
    });
  });

  it("applies a short grace window before marking a due job missing", () => {
    const justAfterEleven = new Date("2026-04-23T11:02:00-04:00");
    expect(
      cronWindow("0 11,15 * * 1-5", justAfterEleven, "America/New_York"),
    ).toEqual({
      scheduledToday: true,
      dueByNow: false,
    });
  });
});
