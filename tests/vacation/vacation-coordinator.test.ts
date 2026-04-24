import { describe, expect, it, vi } from "vitest";
import { createVacationOpsCoordinator } from "../../tools/vacation/vacation-coordinator.ts";

function baseConfig() {
  return {
    timezone: "America/New_York",
  } as any;
}

describe("vacation ops coordinator", () => {
  it("recommends prep roughly 24 hours before departure", () => {
    const coordinator = createVacationOpsCoordinator({
      loadConfig: () => baseConfig(),
    } as any);

    const recommendation = coordinator.recommendWindow({
      start: "2026-04-20T12:00:00.000Z",
      end: "2026-04-30T12:00:00.000Z",
      timezone: "America/New_York",
    });

    expect(recommendation.recommended_prep_at).toBe("2026-04-19T12:00:00.000Z");
  });

  it("rejects prep while an active window already exists", () => {
    const coordinator = createVacationOpsCoordinator({
      loadConfig: () => baseConfig(),
      getActiveVacationWindow: () => ({ label: "vacation-2026-04-20" }),
    } as any);

    expect(() => coordinator.prepareWindow({
      start: "2026-04-20T12:00:00.000Z",
      end: "2026-04-30T12:00:00.000Z",
    })).toThrow(/already active/);
  });

  it("creates and stages a ready window when readiness passes", () => {
    const createVacationWindow = vi.fn(() => ({
      id: 11,
      label: "vacation-2026-04-20",
      status: "prep",
      state_snapshot: {},
      prep_completed_at: null,
    }));
    const updateVacationWindow = vi.fn()
      .mockReturnValueOnce({
        id: 11,
        label: "vacation-2026-04-20",
        status: "prep",
      })
      .mockReturnValueOnce({
        id: 11,
        label: "vacation-2026-04-20",
        status: "ready",
      });
    const runVacationReadiness = vi.fn(() => ({
      outcome: "pass",
      run: { id: 7 },
      actions: [],
      finalResults: [],
      missingRequiredSystemKeys: [],
      tier2WarnSystemKeys: [],
      reasoning: ["tier0_tier1_green"],
    }));

    const coordinator = createVacationOpsCoordinator({
      loadConfig: () => baseConfig(),
      getActiveVacationWindow: () => null,
      getVacationWindow: () => null,
      createVacationWindow,
      updateVacationWindow,
      runVacationReadiness,
      now: () => new Date("2026-04-19T11:00:00.000Z"),
    } as any);

    const result = coordinator.prepareWindow({
      start: "2026-04-20T12:00:00.000Z",
      end: "2026-04-30T12:00:00.000Z",
      timezone: "America/New_York",
    });

    expect(createVacationWindow).toHaveBeenCalledWith(expect.objectContaining({
      label: "vacation-2026-04-20",
      status: "prep",
      timezone: "America/New_York",
    }));
    expect(runVacationReadiness).toHaveBeenCalledWith({
      config: baseConfig(),
      vacationWindowId: 11,
    });
    expect(updateVacationWindow).toHaveBeenLastCalledWith(11, expect.objectContaining({
      status: "ready",
      prepCompletedAt: "2026-04-19T11:00:00.000Z",
    }));
    expect(result.window.status).toBe("ready");
  });

  it("marks a staged window failed when readiness crashes", () => {
    const updateVacationWindow = vi.fn()
      .mockReturnValueOnce({
        id: 11,
        label: "vacation-2026-04-20",
        status: "prep",
      })
      .mockReturnValueOnce({
        id: 11,
        label: "vacation-2026-04-20",
        status: "failed",
      });

    const coordinator = createVacationOpsCoordinator({
      loadConfig: () => baseConfig(),
      getActiveVacationWindow: () => null,
      getVacationWindow: () => ({
        id: 11,
        label: "vacation-2026-04-20",
        status: "prep",
      }),
      updateVacationWindow,
      runVacationReadiness: () => {
        throw new Error("boom");
      },
      now: () => new Date("2026-04-19T11:00:00.000Z"),
    } as any);

    expect(() => coordinator.prepareWindow({
      windowId: 11,
      start: "2026-04-20T12:00:00.000Z",
      end: "2026-04-30T12:00:00.000Z",
    })).toThrow("boom");
    expect(updateVacationWindow).toHaveBeenLastCalledWith(11, expect.objectContaining({
      status: "failed",
      prepCompletedAt: "2026-04-19T11:00:00.000Z",
    }));
  });

  it("builds status from the active window boundary", () => {
    const active = { id: 12, label: "vacation-2026-04-22", status: "active" };
    const latestReadiness = { id: 99, vacation_window_id: 12, readiness_outcome: "pass" };
    const mirror = { enabled: true, windowId: 12 };
    const coordinator = createVacationOpsCoordinator({
      getActiveVacationWindow: () => active,
      getLatestReadinessRun: vi.fn(() => latestReadiness),
      reconcileVacationMirror: () => mirror,
    } as any);

    const result = coordinator.getStatus();

    expect(result).toEqual({
      activeWindow: active,
      latestReadiness,
      mirror,
    });
  });

  it("records summary runs inside the coordinator", () => {
    const startVacationRun = vi.fn(() => ({ id: 51 }));
    const finishVacationRun = vi.fn(() => ({ id: 51, state: "completed" }));
    const coordinator = createVacationOpsCoordinator({
      summarizeActiveVacation: () => ({
        payload: {
          window_id: 12,
          overall_status: "green",
        },
        text: "summary text",
      }),
      startVacationRun,
      finishVacationRun,
    } as any);

    const result = coordinator.summarizeWindow("morning");

    expect(startVacationRun).toHaveBeenCalledWith({
      vacationWindowId: 12,
      runType: "summary_morning",
      triggerSource: "cron",
      dryRun: false,
    });
    expect(finishVacationRun).toHaveBeenCalledWith(51, {
      state: "completed",
      summaryStatus: "green",
      summaryPayload: { window_id: 12, overall_status: "green" },
      summaryText: "summary text",
    });
    expect(result).toMatchObject({
      payload: { window_id: 12 },
      text: "summary text",
      run: { id: 51, state: "completed" },
    });
  });
});
