import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveVacationWindow = vi.hoisted(() => vi.fn());
const getVacationWindow = vi.hoisted(() => vi.fn());
const createVacationWindow = vi.hoisted(() => vi.fn());
const updateVacationWindow = vi.hoisted(() => vi.fn());
const getLatestReadinessRun = vi.hoisted(() => vi.fn());
const startVacationRun = vi.hoisted(() => vi.fn());
const finishVacationRun = vi.hoisted(() => vi.fn());
const reconcileVacationMirror = vi.hoisted(() => vi.fn());
const runVacationReadiness = vi.hoisted(() => vi.fn());

vi.mock("../../tools/vacation/vacation-config.js", () => ({
  loadVacationOpsConfig: vi.fn(() => ({
    timezone: "America/New_York",
    readinessFreshnessHours: 6,
    pausedJobIds: [],
  })),
}));

vi.mock("../../tools/vacation/readiness-engine.js", () => ({
  runVacationReadiness,
}));

vi.mock("../../tools/vacation/vacation-state.js", () => ({
  createVacationWindow,
  finishVacationRun,
  getActiveVacationWindow,
  getLatestReadinessRun,
  getVacationWindow,
  reconcileVacationMirror,
  startVacationRun,
  updateVacationWindow,
}));

vi.mock("../../tools/vacation/vacation-state-machine.js", () => ({
  cancelStagedVacationWindow: vi.fn(),
  enableVacationMode: vi.fn(),
  disableVacationMode: vi.fn(),
  unpauseVacationJobs: vi.fn(),
}));

vi.mock("../../tools/vacation/vacation-summary.js", () => ({
  summarizeActiveVacation: vi.fn(),
}));

describe("vacation ops prep guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveVacationWindow.mockReturnValue(null);
    getVacationWindow.mockReturnValue(null);
  });

  it("rejects prep while an active vacation window exists", async () => {
    getActiveVacationWindow.mockReturnValue({
      id: 10,
      label: "vacation-2026-04-13",
      status: "active",
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { runVacationOps } = await import("../../tools/vacation/vacation-ops.ts");
      const exitCode = runVacationOps([
        "prep",
        "--start", "2026-04-13T18:52:00.000Z",
        "--end", "2026-04-20T18:52:00.000Z",
      ]);

      expect(exitCode).toBe(1);
      expect(runVacationReadiness).not.toHaveBeenCalled();
      expect(createVacationWindow).not.toHaveBeenCalled();
      expect(String(spy.mock.calls.at(-1)?.[0] ?? "")).toContain("already active");
    } finally {
      spy.mockRestore();
    }
  });
});
