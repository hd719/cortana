import { describe, it, expect } from "vitest";
import { renderDigest } from "../../tools/monitoring/weekly-reliability-digest.ts";

describe("weekly-reliability-digest", () => {
  it("renders core metrics and top risks", () => {
    const out = renderDigest(
      {
        window_days: 7,
        generated_at: "2026-03-04T00:00:00Z",
        cron_sla_7d: 98.2,
        cron_sla_prev_7d: 96.1,
        cron_sla_delta: 2.1,
        incident_count_7d: 4,
        mttr_minutes_7d: 18.4,
        open_risk_count: 2,
      },
      [
        { id: 101, title: "Fix alert fanout", status: "ready", priority: 2, severity: "P1" },
      ],
    );

    expect(out).toContain("Weekly Reliability Digest");
    expect(out).toContain("Cron SLA (7d): 98.2%");
    expect(out).toContain("Incidents (warn/error/critical, 7d): 4");
    expect(out).toContain("#101 [P1] Fix alert fanout");
  });

  it("handles missing trend and mttr", () => {
    const out = renderDigest(
      {
        window_days: 7,
        generated_at: "2026-03-04T00:00:00Z",
        cron_sla_7d: null,
        cron_sla_prev_7d: null,
        cron_sla_delta: null,
        incident_count_7d: 0,
        mttr_minutes_7d: null,
        open_risk_count: 0,
      },
      [],
    );

    expect(out).toContain("trend n/a");
    expect(out).toContain("MTTR (resolved immune incidents, 7d): n/a");
  });
});
