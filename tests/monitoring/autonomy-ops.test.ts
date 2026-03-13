import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, mockExit, resetProcess, setArgv, importFresh } from "../test-utils";

const STATE_FILE = path.join(os.tmpdir(), "autonomy-ops-test-state.json");

const collectAutonomyStatus = vi.hoisted(() => vi.fn());
const buildRolloutSummary = vi.hoisted(() => vi.fn());
const runAutonomyDrill = vi.hoisted(() => vi.fn());

vi.mock("../../tools/monitoring/autonomy-status.ts", () => ({ collectAutonomyStatus }));
vi.mock("../../tools/monitoring/autonomy-rollout.ts", () => ({ buildRolloutSummary }));
vi.mock("../../tools/monitoring/autonomy-drill.ts", () => ({ runAutonomyDrill }));

describe("autonomy-ops", () => {
  beforeEach(() => {
    resetProcess();
    process.env.AUTONOMY_OPS_STATE_FILE = STATE_FILE;
    fs.rmSync(STATE_FILE, { force: true });
    collectAutonomyStatus.mockReset();
    buildRolloutSummary.mockReset();
    runAutonomyDrill.mockReset();
  });

  afterEach(() => {
    fs.rmSync(STATE_FILE, { force: true });
    vi.restoreAllMocks();
    resetProcess();
  });

  it("stays quiet when operator surface is live and healthy", async () => {
    const consoleSpy = captureConsole();
    const exitSpy = mockExit();
    collectAutonomyStatus.mockReturnValue({
      posture: "balanced",
      autoFixedItems: [], deferredItems: [], waitingOnHuman: [],
      autoRemediated: 0, escalated: 0, needsHuman: 0, actionable: 0, suppressed: 2,
      scorecard: { counts: { autoFixAttempted: 0, autoFixSucceeded: 0, escalations: 0, blockedOrExceededAuthority: 0, staleReportSuppressions: 0, familyCriticalFailures: 0 }, activeFollowUps: [] },
    });
    buildRolloutSummary.mockReturnValue({ status: "live", reasons: [] });
    runAutonomyDrill.mockReturnValue({ status: "live", familyCriticalFailures: 0, scenarios: [] });

    setArgv([]);
    await importFresh("../../tools/monitoring/autonomy-ops.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    expect(consoleSpy.logs).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("reports watch/attention state with one clean operator surface", async () => {
    const consoleSpy = captureConsole();
    const exitSpy = mockExit();
    collectAutonomyStatus.mockReturnValue({
      posture: "balanced",
      autoFixedItems: ["gateway"],
      deferredItems: ["channel:escalate"],
      waitingOnHuman: ["1 escalated check(s)"],
      autoRemediated: 1,
      escalated: 1,
      needsHuman: 1,
      actionable: 0,
      suppressed: 1,
      scorecard: { counts: { autoFixAttempted: 4, autoFixSucceeded: 2, escalations: 1, blockedOrExceededAuthority: 1, staleReportSuppressions: 3, familyCriticalFailures: 0 }, activeFollowUps: [{ system: "channel", taskId: 12 }] },
    });
    buildRolloutSummary.mockReturnValue({ status: "attention", reasons: ["1 escalated check(s)"] });
    runAutonomyDrill.mockReturnValue({
      status: "live",
      familyCriticalFailures: 0,
      scenarios: [{ scenario: "family_critical", lane: "family_critical", passed: true }],
    });

    setArgv([]);
    await importFresh("../../tools/monitoring/autonomy-ops.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    const output = consoleSpy.logs.join("\n");
    expect(output).toContain("🧭 Autonomy - Operator Attention");
    expect(output).toContain("Posture: balanced");
    expect(output).toContain("Auto-fixed: gateway");
    expect(output).toContain("Degraded: channel:escalate");
    expect(output).toContain("Waiting on Hamel: 1 escalated check(s)");
    expect(output).toContain("Family-critical failures: 0");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("suppresses unchanged repeated operator chatter", async () => {
    const response = {
      posture: "balanced",
      autoFixedItems: ["gateway"],
      deferredItems: ["channel:escalate"],
      waitingOnHuman: ["1 escalated check(s)"],
      autoRemediated: 1,
      escalated: 1,
      needsHuman: 1,
      actionable: 0,
      suppressed: 1,
      scorecard: { counts: { autoFixAttempted: 4, autoFixSucceeded: 2, escalations: 1, blockedOrExceededAuthority: 1, staleReportSuppressions: 3, familyCriticalFailures: 0 }, activeFollowUps: [{ system: "channel", taskId: 12 }] },
    };

    collectAutonomyStatus.mockReturnValue(response);
    buildRolloutSummary.mockReturnValue({ status: "attention", reasons: ["1 escalated check(s)"] });
    runAutonomyDrill.mockReturnValue({
      status: "live",
      familyCriticalFailures: 0,
      scenarios: [{ scenario: "family_critical", lane: "family_critical", passed: true }],
    });

    setArgv([]);
    const firstConsole = captureConsole();
    const firstExit = mockExit();
    await importFresh("../../tools/monitoring/autonomy-ops.ts");
    await flushModuleSideEffects();
    firstConsole.restore();
    firstExit.mockRestore();

    setArgv([]);
    const secondConsole = captureConsole();
    const secondExit = mockExit();
    await importFresh("../../tools/monitoring/autonomy-ops.ts");
    await flushModuleSideEffects();
    secondConsole.restore();

    expect(firstConsole.logs.join("\n")).toContain("🧭 Autonomy - Operator Attention");
    expect(secondConsole.logs).toEqual([]);
    expect(secondExit).not.toHaveBeenCalled();
  });
});
