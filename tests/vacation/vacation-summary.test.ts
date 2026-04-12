import { describe, expect, it } from "vitest";
import { renderVacationSummaryText } from "../../tools/vacation/vacation-summary.ts";

describe("vacation summary", () => {
  it("renders compact summary text from the canonical payload", () => {
    const text = renderVacationSummaryText({
      window_id: 1,
      period: "morning",
      overall_status: "green",
      readiness_outcome: "pass",
      active_incident_count: 0,
      resolved_incident_count: 0,
      human_required_count: 0,
      paused_job_ids: ["af9e1570-3ba2-4d10-a807-91cdfc2df18b"],
      paused_jobs: [
        {
          id: "af9e1570-3ba2-4d10-a807-91cdfc2df18b",
          name: "🔄 Daily Auto-Update (notify Hamel)",
        },
      ],
      last_transition_at: "2026-04-10T12:00:00.000Z",
      latest_readiness_run_id: 10,
      active_systems: [],
      degraded_systems: [],
      self_heal_count: 0,
      degradation_summary: "none",
    });

    expect(text).toContain("Vacation Ops AM");
    expect(text).toContain("🔄 Daily Auto-Update (notify Hamel)");
    expect(text.split("\n")).toHaveLength(4);
  });
});
