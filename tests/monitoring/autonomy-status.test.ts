import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, resetProcess, setArgv } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync }));

describe("autonomy-status", () => {
  beforeEach(() => {
    spawnSync.mockReset();
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
        stdout: JSON.stringify({ remediated: 2, escalated: 1, healthy: 0, skipped: 0 }),
        stderr: "",
      });

    setArgv([]);
    const consoleSpy = captureConsole();
    await importFresh("../../tools/monitoring/autonomy-status.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    const output = consoleSpy.logs.join("\n");
    expect(output).toContain("🤖 Autonomy Status");
    expect(output).toContain("auto-remediated: 3");
    expect(output).toContain("escalated: 1");
    expect(output).toContain("suppressed healthy/noise: 1");
    expect(output).toContain("needs human action: 2");
    expect(output).toContain("service remediation: remediated=2 escalated=1 healthy=0 skipped=0");
    expect(output).toContain("actionable drift: cron/jobs.json");
    expect(output).toContain("suppressed drift: agent-profiles.json");
  });
});
