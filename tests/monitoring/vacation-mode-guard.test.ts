import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadVacationOpsConfig = vi.hoisted(() => vi.fn());
const getActiveVacationWindow = vi.hoisted(() => vi.fn());
const reconcileVacationMirror = vi.hoisted(() => vi.fn());
const updateVacationWindow = vi.hoisted(() => vi.fn());
const disableVacationMode = vi.hoisted(() => vi.fn());

vi.mock("../../tools/vacation/vacation-config.ts", () => ({
  loadVacationOpsConfig,
}));

vi.mock("../../tools/vacation/vacation-state.ts", () => ({
  getActiveVacationWindow,
  reconcileVacationMirror,
  updateVacationWindow,
}));

vi.mock("../../tools/vacation/vacation-state-machine.ts", () => ({
  disableVacationMode,
}));

describe("vacation mode guard", () => {
  beforeEach(() => {
    loadVacationOpsConfig.mockReset();
    getActiveVacationWindow.mockReset();
    reconcileVacationMirror.mockReset();
    updateVacationWindow.mockReset();
    disableVacationMode.mockReset();
  });

  it("persists quarantined job ids back into canonical vacation state", async () => {
    loadVacationOpsConfig.mockReturnValue({
      guard: {
        fragileCronMatchers: ["Stock Market Brief"],
        quarantineAfterConsecutiveErrors: 1,
      },
    });
    getActiveVacationWindow.mockReturnValue({
      id: 42,
      end_at: "2026-04-30T12:00:00.000Z",
      state_snapshot: {
        paused_job_ids: ["baseline-job"],
      },
    });
    updateVacationWindow.mockReturnValue({ id: 42 });

    const { runVacationModeGuard } = await import("../../tools/monitoring/vacation-mode-guard.ts");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vacation-guard-"));
    const runtimeJobsPath = path.join(tempDir, "jobs.json");
    const quarantineDir = path.join(tempDir, "quarantine");
    fs.writeFileSync(runtimeJobsPath, JSON.stringify({
      jobs: [
        {
          id: "fragile-job",
          name: "📈 Stock Market Brief (daily)",
          enabled: true,
          state: { consecutiveErrors: 2 },
        },
      ],
    }), "utf8");

    const output = runVacationModeGuard({ runtimeJobsPath, quarantineDir });

    expect(output).toContain("quarantined fragile cron jobs");
    expect(updateVacationWindow).toHaveBeenCalledWith(42, expect.objectContaining({
      stateSnapshot: expect.objectContaining({
        paused_job_ids: ["baseline-job", "fragile-job"],
        quarantined_job_ids: ["fragile-job"],
      }),
    }));
    expect(reconcileVacationMirror).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(quarantineDir, "📈 Stock Market Brief (daily).quarantined"))).toBe(true);
  });
});
