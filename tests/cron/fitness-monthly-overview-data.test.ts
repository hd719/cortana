import { describe, expect, it } from "vitest";
import {
  completedMonthlyWindows,
  monthlyWindows,
  stepCoverageReason,
  trajectoryReason,
} from "../../tools/fitness/monthly-overview-data.ts";

describe("fitness monthly overview windows", () => {
  it("returns current and previous month windows from anchor date", () => {
    const windows = monthlyWindows("2026-03-18");
    expect(windows.current.start).toBe("2026-03-01");
    expect(windows.current.end).toBe("2026-03-31");
    expect(windows.previous.start).toBe("2026-02-01");
    expect(windows.previous.end).toBe("2026-02-28");
  });

  it("handles year boundary correctly", () => {
    const windows = monthlyWindows("2026-01-11");
    expect(windows.current.start).toBe("2026-01-01");
    expect(windows.previous.start).toBe("2025-12-01");
    expect(windows.previous.end).toBe("2025-12-31");
  });

  it("returns the most recently completed month window for first-of-month runs", () => {
    const windows = completedMonthlyWindows("2026-04-01");
    expect(windows.current.start).toBe("2026-03-01");
    expect(windows.current.end).toBe("2026-03-31");
    expect(windows.previous.start).toBe("2026-02-01");
    expect(windows.previous.end).toBe("2026-02-28");
  });

  it("explains unknown trajectory when prior month coverage is missing", () => {
    const current = {
      days_with_data: 14,
    } as any;
    const previous = {
      days_with_data: 0,
    } as any;

    expect(trajectoryReason(current, previous)).toBe("no prior completed-month baseline with sufficient coverage");
  });

  it("explains missing step coverage even when other fitness snapshots exist", () => {
    const current = {
      days_with_steps: 0,
      days_with_data: 14,
    } as any;

    expect(stepCoverageReason(current)).toContain("Whoop/Tonal fitness snapshots exist");
  });
});
