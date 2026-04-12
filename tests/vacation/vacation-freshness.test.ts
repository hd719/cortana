import { describe, expect, it } from "vitest";
import { isFreshReadinessRun } from "../../tools/vacation/readiness-engine.ts";

describe("vacation readiness freshness", () => {
  it("rejects stale readiness runs", () => {
    expect(isFreshReadinessRun({
      id: 1,
      run_type: "readiness",
      trigger_source: "manual_command",
      dry_run: false,
      readiness_outcome: "pass",
      summary_payload: {},
      summary_text: "",
      started_at: "2026-04-11T00:00:00.000Z",
      completed_at: "2026-04-11T00:00:00.000Z",
      state: "completed",
    }, 6, new Date("2026-04-11T08:00:01.000Z"))).toBe(false);
  });

  it("accepts fresh PASS or WARN readiness runs", () => {
    expect(isFreshReadinessRun({
      id: 1,
      run_type: "readiness",
      trigger_source: "manual_command",
      dry_run: false,
      readiness_outcome: "warn",
      summary_payload: {},
      summary_text: "",
      started_at: "2026-04-11T06:00:00.000Z",
      completed_at: "2026-04-11T06:00:00.000Z",
      state: "completed",
    }, 6, new Date("2026-04-11T08:00:00.000Z"))).toBe(true);
  });
});
