import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, resetProcess, setArgv } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());
const collectAutonomyScorecard = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync }));
vi.mock("../../tools/monitoring/autonomy-scorecard.ts", () => ({ collectAutonomyScorecard }));

describe("autonomy-status", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    collectAutonomyScorecard.mockReset();
    collectAutonomyScorecard.mockReturnValue({
      windowHours: 168,
      counts: { autoFixAttempted: 0, autoFixSucceeded: 0, escalations: 0, blockedOrExceededAuthority: 0, staleReportSuppressions: 0, familyCriticalFailures: 0 },
      activeFollowUps: [],
      incidentReviews: [],
    });
    resetProcess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  it("summarizes auto-remediated, escalated, suppressed, and human-action counts", async () => {
    spawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ status: "remediated", breachesBefore: [{ bucket: "cron", count: 12, max: 10 }], breachesAfter: [], cleanupChangedCount: 4 }),
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ status: "needs_action", actionable: [{ check: { label: "cron/jobs.json" } }], suppressed: [{ check: { label: "agent-profiles.json" } }], missing: [] }),
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          posture: "balanced",
          remediated: 2,
          escalated: 1,
          healthy: 0,
          skipped: 0,
          items: [
            { system: "gateway", status: "remediated" },
            { system: "cron", status: "remediated", verification: JSON.stringify({ familyCritical: { recovered: 1, escalations: 1 } }) },
            { system: "channel", status: "escalate" }
          ]
        }),
        stderr: "",
      });

    collectAutonomyScorecard.mockReturnValue({
      windowHours: 168,
      counts: {
        autoFixAttempted: 4,
        autoFixSucceeded: 2,
        escalations: 1,
        blockedOrExceededAuthority: 0,
        staleReportSuppressions: 1,
        familyCriticalFailures: 1,
      },
      activeFollowUps: [{ system: "channel", taskId: 12 }],
      incidentReviews: [],
    });

    setArgv([]);
    const consoleSpy = captureConsole();
    await importFresh("../../tools/monitoring/autonomy-status.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    const output = consoleSpy.logs.join("\n");
    expect(output).toContain("🤖 Autonomy Status");
    expect(output).toContain("posture: balanced");
    expect(output).toContain("auto-remediated: 3");
    expect(output).toContain("escalated: 1");
    expect(output).toContain("suppressed healthy/noise: 1");
    expect(output).toContain("needs human action: 2");
    expect(output).toContain("auto-fixed today: gateway, cron");
    expect(output).toContain("failed then recovered: gateway, cron");
    expect(output).toContain("waiting on Hamel: 1 drift item(s), 1 escalated check(s)");
    expect(output).toContain("deferred/exceeded authority: channel:escalate");
    expect(output).toContain("family-critical lane: recovered=1 escalated=1");
    expect(output).toContain("service remediation: remediated=2 escalated=1 healthy=0 skipped=0");
    expect(output).toContain("actionable drift: cron/jobs.json");
    expect(output).toContain("suppressed drift: agent-profiles.json");
  });

  it("emits machine-readable json with the same operational summary", async () => {
    spawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ status: "healthy" }),
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ status: "healthy", actionable: [], suppressed: [], missing: [] }),
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ posture: "balanced", remediated: 0, escalated: 0, healthy: 4, skipped: 0, items: [] }),
        stderr: "",
      });

    setArgv(["--json"]);
    const consoleSpy = captureConsole();
    await importFresh("../../tools/monitoring/autonomy-status.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    const parsed = JSON.parse(consoleSpy.logs.join("\n"));
    expect(parsed).toMatchObject({
      posture: "balanced",
      autoRemediated: 0,
      escalated: 0,
      suppressed: 0,
      actionable: 0,
      missing: 0,
      needsHuman: 0,
      sessionStatus: "healthy",
      driftStatus: "healthy",
      remediationCounts: { remediated: 0, escalated: 0, healthy: 4, skipped: 0 },
      familyCritical: { recovered: 0, escalated: 0 },
    });
  });

  it("still summarizes remediation output when a child check exits non-zero with json", async () => {
    spawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ status: "healthy" }),
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ status: "healthy", actionable: [], suppressed: [], missing: [] }),
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: JSON.stringify({ posture: "balanced", remediated: 0, escalated: 1, healthy: 3, skipped: 0, items: [{ system: "session", status: "escalate" }] }),
        stderr: "",
      });

    collectAutonomyScorecard.mockReturnValue({
      windowHours: 168,
      counts: {
        autoFixAttempted: 1,
        autoFixSucceeded: 0,
        escalations: 1,
        blockedOrExceededAuthority: 0,
        staleReportSuppressions: 0,
        familyCriticalFailures: 0,
      },
      activeFollowUps: [{ system: "session", taskId: 55 }],
      incidentReviews: [],
    });

    setArgv(["--json"]);
    const consoleSpy = captureConsole();
    await importFresh("../../tools/monitoring/autonomy-status.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    const parsed = JSON.parse(consoleSpy.logs.join("\n"));
    expect(parsed).toMatchObject({
      escalated: 1,
      needsHuman: 1,
      deferredItems: ["session:escalate"],
    });
  });
});
