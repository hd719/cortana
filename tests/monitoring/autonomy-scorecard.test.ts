import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, resetProcess, setArgv } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync }));

describe("autonomy-scorecard", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    resetProcess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  it("summarizes trust metrics and active follow-ups from autonomy events", async () => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        windowHours: 168,
        counts: {
          autoFixAttempted: 5,
          autoFixSucceeded: 3,
          escalations: 2,
          blockedOrExceededAuthority: 1,
          staleReportSuppressions: 4,
          familyCriticalFailures: 1,
        },
        activeFollowUps: [
          {
            system: "cron",
            status: "escalate",
            detail: "critical cron failures repeated",
            taskId: 42,
            createdAt: "2026-03-11T15:30:00Z",
          }
        ],
        incidentReviews: [
          {
            system: "cron",
            lane: "pregnancy reminders/checklists",
            familyCritical: true,
            status: "escalate",
            whatFailed: "critical cron failures were repeated",
            actionTaken: "single critical cron retry",
            verificationStatus: "uncertain",
            recovered: false,
            followUp: "page Hamel because family-critical delivery is still uncertain after one bounded retry",
            policyLesson: "family-critical reminders escalate after one failed verification path",
            taskId: 42,
            createdAt: "2026-03-11T15:30:00Z"
          }
        ]
      }),
      stderr: "",
    });

    setArgv(["--json"]);
    const consoleSpy = captureConsole();
    const { runAutonomyScorecardCli } = await importFresh("../../tools/monitoring/autonomy-scorecard.ts");
    runAutonomyScorecardCli();
    await flushModuleSideEffects();
    consoleSpy.restore();

    const parsed = JSON.parse(consoleSpy.logs.join("\n"));
    expect(parsed).toMatchObject({
      windowHours: 168,
      counts: {
        autoFixAttempted: 5,
        autoFixSucceeded: 3,
        escalations: 2,
        blockedOrExceededAuthority: 1,
        staleReportSuppressions: 4,
        familyCriticalFailures: 1,
      },
    });
    expect(parsed.activeFollowUps).toHaveLength(1);
    expect(parsed.activeFollowUps[0]).toMatchObject({
      system: "cron",
      taskId: 42,
    });
    expect(parsed.incidentReviews).toHaveLength(1);
    expect(parsed.incidentReviews[0]).toMatchObject({
      system: "cron",
      familyCritical: true,
      verificationStatus: "uncertain",
      taskId: 42,
    });
  });


  it("bounds incident reviews in the scorecard SQL", async () => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        windowHours: 168,
        counts: {},
        activeFollowUps: [],
        incidentReviews: [],
      }),
      stderr: "",
    });

    const { collectAutonomyScorecard } = await importFresh("../../tools/monitoring/autonomy-scorecard.ts");
    collectAutonomyScorecard();

    const sql = String(spawnSync.mock.calls[0][1].at(-1));
    expect(sql).toContain("LIMIT 25");
    expect(sql).toContain("LEFT(COALESCE(r.metadata->>'detail', r.message, ''), 600)");
    expect(sql).toContain("LEFT(l.detail, 600)");
  });

  it("keeps psql buffer failures compact", async () => {
    const error = Object.assign(new Error("spawnSync psql ENOBUFS"), { code: "ENOBUFS" });
    spawnSync.mockReturnValue({
      status: null,
      error,
      stdout: "x".repeat(5000),
      stderr: "",
    });

    const { collectAutonomyScorecard } = await importFresh("../../tools/monitoring/autonomy-scorecard.ts");
    expect(() => collectAutonomyScorecard()).toThrow(/psql failed \(ENOBUFS\)/);

    try {
      collectAutonomyScorecard();
    } catch (err) {
      expect(String((err as Error).message).length).toBeLessThan(1200);
      expect(String((err as Error).message)).toContain("truncated");
    }
  });

});
