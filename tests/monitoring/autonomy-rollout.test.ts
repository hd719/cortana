import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const collectAutonomyStatus = vi.hoisted(() => vi.fn());
vi.mock("../../tools/monitoring/autonomy-status.ts", () => ({
  collectAutonomyStatus,
}));

describe("autonomy-rollout", () => {
  beforeEach(() => {
    collectAutonomyStatus.mockReset();
    resetProcess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  it("stays quiet when autonomy is live and healthy", async () => {
    const exitSpy = mockExit();
    const consoleSpy = captureConsole();
    collectAutonomyStatus.mockReturnValue({
      posture: "balanced",
      autoRemediated: 0,
      escalated: 0,
      actionable: 0,
      missing: 0,
      needsHuman: 0,
      deferredItems: [],
    });

    setArgv([]);
    const { runAutonomyRolloutCli } = await importFresh("../../tools/monitoring/autonomy-rollout.ts");
    runAutonomyRolloutCli();
    await flushModuleSideEffects();
    consoleSpy.restore();

    expect(consoleSpy.logs).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("reports watch mode without paging when bounded remediation handled issues", async () => {
    const exitSpy = mockExit();
    const consoleSpy = captureConsole();
    collectAutonomyStatus.mockReturnValue({
      posture: "balanced",
      autoRemediated: 2,
      escalated: 0,
      actionable: 0,
      missing: 0,
      needsHuman: 0,
      deferredItems: [],
    });

    setArgv([]);
    const { runAutonomyRolloutCli } = await importFresh("../../tools/monitoring/autonomy-rollout.ts");
    runAutonomyRolloutCli();
    await flushModuleSideEffects();
    consoleSpy.restore();

    const output = consoleSpy.logs.join("\n");
    expect(output).toContain("status: watch");
    expect(output).toContain("bounded fixes observed: 2");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("fails loudly when autonomy needs operator attention", async () => {
    const exitSpy = mockExit();
    const consoleSpy = captureConsole();
    collectAutonomyStatus.mockReturnValue({
      posture: "balanced",
      autoRemediated: 1,
      escalated: 1,
      actionable: 1,
      missing: 0,
      needsHuman: 2,
      deferredItems: ["channel:escalate"],
    });

    setArgv([]);
    const { runAutonomyRolloutCli } = await importFresh("../../tools/monitoring/autonomy-rollout.ts");
    runAutonomyRolloutCli();
    await flushModuleSideEffects();
    consoleSpy.restore();

    const output = consoleSpy.logs.join("\n");
    expect(output).toContain("status: attention");
    expect(output).toContain("activation: hold");
    expect(output).toContain("attention reasons: 1 escalated check(s), 1 actionable drift item(s), deferred: channel:escalate");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("emits json for automation consumers", async () => {
    const consoleSpy = captureConsole();
    collectAutonomyStatus.mockReturnValue({
      posture: "balanced",
      autoRemediated: 0,
      escalated: 0,
      actionable: 0,
      missing: 0,
      needsHuman: 0,
      deferredItems: [],
    });

    setArgv(["--json"]);
    const { runAutonomyRolloutCli } = await importFresh("../../tools/monitoring/autonomy-rollout.ts");
    runAutonomyRolloutCli(["--json"]);
    await flushModuleSideEffects();
    consoleSpy.restore();

    const parsed = JSON.parse(consoleSpy.logs.join("\n"));
    expect(parsed).toMatchObject({
      status: "live",
      activation: "active",
      cadence: "check every 4h; operator summary only on attention",
      operatorLoop: "healthy path quiet; continue steady-state monitoring",
    });
  });
});
