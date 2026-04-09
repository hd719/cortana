import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, resetProcess } from "../test-utils";

const readFileSync = vi.hoisted(() => vi.fn());
const reconcileMissionControlFeedbackSignal = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("node:fs", () => ({
  default: {
    readFileSync,
  },
}));

vi.mock("../../tools/feedback/mission-control-feedback-signal.js", () => ({
  reconcileMissionControlFeedbackSignal,
}));

describe("cron-slo-monitor", () => {
  beforeEach(() => {
    readFileSync.mockReset();
    reconcileMissionControlFeedbackSignal.mockReset();
    reconcileMissionControlFeedbackSignal.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  it("returns NO_REPLY and clears feedback when runtime jobs are healthy", async () => {
    readFileSync.mockReturnValue(JSON.stringify({
      jobs: [
        {
          id: "brief",
          name: "☀️ Morning brief (Hamel)",
          enabled: true,
          state: {
            consecutiveErrors: 0,
            lastDurationMs: 1000,
            nextRunAtMs: Date.now() + 60_000,
            lastDeliveryStatus: "ok",
          },
          payload: { timeoutSeconds: 60 },
        },
      ],
    }));

    const consoleSpy = captureConsole();
    await importFresh("../../tools/monitoring/cron-slo-monitor.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    expect(consoleSpy.logs.join("\n").trim()).toBe("NO_REPLY");
    expect(reconcileMissionControlFeedbackSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        recurrenceKey: "ops:cron-slo-monitor",
        signalState: "cleared",
      }),
    );
  });

  it("emits actionable output and activates feedback when thresholds are exceeded", async () => {
    readFileSync.mockReturnValue(JSON.stringify({
      jobs: [
        {
          id: "calendar",
          name: "📅 Calendar reminders → Telegram (ALL calendars)",
          enabled: true,
          state: {
            consecutiveErrors: 2,
            lastDurationMs: 55_000,
            nextRunAtMs: Date.now() - (31 * 60 * 1000),
            lastDeliveryStatus: "failed",
          },
          payload: { timeoutSeconds: 60 },
        },
      ],
    }));

    const consoleSpy = captureConsole();
    await importFresh("../../tools/monitoring/cron-slo-monitor.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    const output = consoleSpy.logs.join("\n");
    expect(output).toContain("📏 Cron SLO Monitor");
    expect(output).toContain("Actionable thresholds exceeded:");
    expect(reconcileMissionControlFeedbackSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        recurrenceKey: "ops:cron-slo-monitor",
        signalState: "active",
      }),
    );
  });
});
