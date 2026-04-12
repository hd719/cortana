import { describe, expect, it } from "vitest";
import { buildVacationSummaryPayload, renderVacationSummaryText } from "../../tools/vacation/vacation-summary.ts";

describe("vacation summary", () => {
  it("renders compact summary text from the canonical payload", () => {
    const payload = buildVacationSummaryPayload({
      window: {
        id: 1,
        label: "vacation-2026-04-20",
        status: "active",
        timezone: "America/New_York",
        start_at: "2026-04-20T12:00:00.000Z",
        end_at: "2026-04-30T12:00:00.000Z",
        trigger_source: "manual_command",
        created_by: "hamel",
        config_snapshot: {},
        state_snapshot: { paused_job_ids: ["af9e1570-3ba2-4d10-a807-91cdfc2df18b"] },
        created_at: "2026-04-10T12:00:00.000Z",
        updated_at: "2026-04-10T12:00:00.000Z",
      } as any,
      period: "morning",
      incidents: [],
      readinessOutcome: "pass",
      latestReadinessRunId: 10,
    });
    const text = renderVacationSummaryText(payload);
    expect(text).toContain("Vacation Ops AM");
    expect(text.split("\n")).toHaveLength(4);
  });
});
