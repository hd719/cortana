import { describe, expect, it } from "vitest";
import { computeStalenessBanner } from "../../tools/monitoring/staleness";

describe("computeStalenessBanner", () => {
  const now = new Date("2026-03-04T17:00:00.000Z");

  it("returns fresh when age is below warning threshold", () => {
    const res = computeStalenessBanner("2026-03-04T16:58:00.000Z", now);
    expect(res.stale).toBe(false);
    expect(res.severity).toBe("fresh");
  });

  it("returns warning when age passes warning threshold", () => {
    const res = computeStalenessBanner("2026-03-04T16:53:00.000Z", now);
    expect(res.stale).toBe(true);
    expect(res.severity).toBe("warning");
  });

  it("returns critical when timestamp is missing", () => {
    const res = computeStalenessBanner(null, now);
    expect(res.stale).toBe(true);
    expect(res.severity).toBe("critical");
  });
});
