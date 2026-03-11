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
          },
        ],
      }),
      stderr: "",
    });

    setArgv(["--json"]);
    const consoleSpy = captureConsole();
    await importFresh("../../tools/monitoring/autonomy-scorecard.ts");
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
  });
});
