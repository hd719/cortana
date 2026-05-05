import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const loadAutonomyConfig = vi.hoisted(() => vi.fn());
vi.mock("../../tools/monitoring/autonomy-lanes.ts", () => ({
  loadAutonomyConfig,
}));

describe("autonomy-drill", () => {
  beforeEach(() => {
    loadAutonomyConfig.mockReset();
    loadAutonomyConfig.mockReturnValue({
      posture: "balanced",
      familyCriticalCronNames: ["📅 Calendar reminders → Telegram (ALL calendars)", "🤰 Pregnancy reminders / checklist"],
      notes: [],
    });
    resetProcess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  it("renders bounded drill readiness across scenarios", async () => {
    const consoleSpy = captureConsole();
    const exitSpy = mockExit();

    setArgv([]);
    const { runAutonomyDrillCli } = await importFresh("../../tools/monitoring/autonomy-drill.ts");
    runAutonomyDrillCli();
    await flushModuleSideEffects();
    consoleSpy.restore();

    const output = consoleSpy.logs.join("\n");
    expect(output).toContain("🧪 Autonomy Drill Readiness");
    expect(output).toContain("status: live");
    expect(output).toContain("family-critical failures: 0");
    expect(output).toContain("gateway: ready");
    expect(output).toContain("family_critical");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("emits json for automation consumers", async () => {
    const consoleSpy = captureConsole();
    setArgv(["--json", "--scenario", "family_critical"]);

    const { runAutonomyDrillCli } = await importFresh("../../tools/monitoring/autonomy-drill.ts");
    runAutonomyDrillCli(["--json", "--scenario", "family_critical"]);
    await flushModuleSideEffects();
    consoleSpy.restore();

    const parsed = JSON.parse(consoleSpy.logs.join("\n"));
    expect(parsed).toMatchObject({
      posture: "balanced",
      status: "live",
      failures: 0,
      familyCriticalFailures: 0,
    });
    expect(parsed.scenarios).toHaveLength(1);
    expect(parsed.scenarios[0]).toMatchObject({
      scenario: "family_critical",
      lane: "family_critical",
      severity: "attention",
    });
  });
});
