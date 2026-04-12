import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveVacationWindow = vi.hoisted(() => vi.fn());
const getLatestReadinessRun = vi.hoisted(() => vi.fn());
const getVacationWindow = vi.hoisted(() => vi.fn());
const createVacationWindow = vi.hoisted(() => vi.fn());
const updateVacationWindow = vi.hoisted(() => vi.fn());
const startVacationRun = vi.hoisted(() => vi.fn());
const finishVacationRun = vi.hoisted(() => vi.fn());
const setRuntimeCronJobsEnabled = vi.hoisted(() => vi.fn());
const writeVacationMirror = vi.hoisted(() => vi.fn());
const archiveVacationMirror = vi.hoisted(() => vi.fn());
const clearVacationMirror = vi.hoisted(() => vi.fn());

vi.mock("../../tools/vacation/vacation-state.ts", () => ({
  getActiveVacationWindow,
  getLatestReadinessRun,
  getVacationWindow,
  createVacationWindow,
  updateVacationWindow,
  startVacationRun,
  finishVacationRun,
  setRuntimeCronJobsEnabled,
  writeVacationMirror,
  archiveVacationMirror,
  clearVacationMirror,
  buildVacationMirror: vi.fn(() => ({ enabled: true, windowId: 1 })),
}));

describe("vacation state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveVacationWindow.mockReturnValue(null);
    getVacationWindow.mockReturnValue(null);
  });

  it("rejects enable when the latest readiness run is stale", async () => {
    createVacationWindow.mockReturnValue({
      id: 11,
      label: "vacation-2026-04-20",
      state_snapshot: {},
    });
    getLatestReadinessRun.mockReturnValue({
      id: 1,
      readiness_outcome: "pass",
      completed_at: "2026-04-10T00:00:00.000Z",
    });
    const { enableVacationMode } = await import("../../tools/vacation/vacation-state-machine.ts");
    expect(() => enableVacationMode({
      config: {
        readinessFreshnessHours: 6,
        timezone: "America/New_York",
        pausedJobIds: ["af9e1570-3ba2-4d10-a807-91cdfc2df18b"],
      } as any,
      startAt: "2026-04-20T12:00:00.000Z",
      endAt: "2026-04-30T12:00:00.000Z",
    })).toThrow(/stale/);
    expect(getLatestReadinessRun).toHaveBeenCalledWith(11);
  });

  it("scopes readiness to the resolved window before enabling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-11T13:00:00.000Z"));
    try {
      createVacationWindow.mockReturnValue({
        id: 42,
        label: "vacation-2026-04-20",
        state_snapshot: {},
      });
      getLatestReadinessRun.mockImplementation((windowId?: number | null) => (
        windowId === 42
          ? {
              id: 7,
              readiness_outcome: "pass",
              completed_at: "2026-04-11T12:00:00.000Z",
            }
          : null
      ));
      startVacationRun.mockReturnValue({ id: 9 });
      setRuntimeCronJobsEnabled.mockReturnValue(["job-a"]);
      updateVacationWindow.mockReturnValue({
        id: 42,
        label: "vacation-2026-04-20",
        state_snapshot: { paused_job_ids: ["job-a"] },
      });
      finishVacationRun.mockReturnValue({ id: 9 });

      const { enableVacationMode } = await import("../../tools/vacation/vacation-state-machine.ts");
      const result = enableVacationMode({
        config: {
          readinessFreshnessHours: 6,
          timezone: "America/New_York",
          pausedJobIds: ["job-a", "job-b"],
        } as any,
        startAt: "2026-04-20T12:00:00.000Z",
        endAt: "2026-04-30T12:00:00.000Z",
      });

      expect(result.pausedJobIds).toEqual(["job-a"]);
      expect(getLatestReadinessRun).toHaveBeenCalledWith(42);
      expect(createVacationWindow.mock.invocationCallOrder[0]).toBeLessThan(getLatestReadinessRun.mock.invocationCallOrder[0]);
      expect(updateVacationWindow).toHaveBeenCalledWith(42, expect.objectContaining({
        stateSnapshot: expect.objectContaining({
          paused_job_ids: ["job-a"],
          latest_readiness_run_id: 7,
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores paused jobs on disable", async () => {
    getActiveVacationWindow.mockReturnValue({
      id: 1,
      label: "vacation-2026-04-20",
      state_snapshot: {
        paused_job_ids: ["af9e1570-3ba2-4d10-a807-91cdfc2df18b", "fragile-job"],
      },
    });
    startVacationRun.mockReturnValue({ id: 4 });
    setRuntimeCronJobsEnabled.mockReturnValue(["af9e1570-3ba2-4d10-a807-91cdfc2df18b", "fragile-job"]);
    updateVacationWindow.mockReturnValue({ id: 1, label: "vacation-2026-04-20" });
    finishVacationRun.mockReturnValue({ id: 4 });
    archiveVacationMirror.mockReturnValue("/tmp/vacation-mode.json.bak");
    const { disableVacationMode } = await import("../../tools/vacation/vacation-state-machine.ts");
    const result = disableVacationMode({
      config: { pausedJobIds: ["af9e1570-3ba2-4d10-a807-91cdfc2df18b"] } as any,
      reason: "manual",
    });
    expect(result.restoredJobIds).toEqual(["af9e1570-3ba2-4d10-a807-91cdfc2df18b", "fragile-job"]);
    expect(setRuntimeCronJobsEnabled).toHaveBeenCalledWith(
      ["af9e1570-3ba2-4d10-a807-91cdfc2df18b", "fragile-job"],
      true,
    );
  });
});
