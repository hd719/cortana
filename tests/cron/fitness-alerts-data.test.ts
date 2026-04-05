import { describe, expect, it } from "vitest";

import {
  buildAlertPolicyInput,
  parseRequestedAlertTypes,
  selectPrimaryAlert,
} from "../../tools/fitness/fitness-alerts-data.ts";

describe("fitness alerts data helpers", () => {
  it("parses requested alert types conservatively", () => {
    expect(parseRequestedAlertTypes("freshness,overreach")).toEqual(["freshness", "overreach"]);
    expect(parseRequestedAlertTypes("invalid")).toEqual([
      "freshness",
      "recovery_risk",
      "overreach",
      "protein_miss",
      "pain",
      "schedule_conflict",
    ]);
  });

  it("builds alert policy input from morning, evening, and check-in evidence", () => {
    const input = buildAlertPolicyInput({
      dateLocal: "2026-04-05",
      morningArtifact: {
        morning_readiness: { band: "yellow" },
        readiness_signal: { riskFlags: ["hrv_down_vs_baseline"] },
        data_freshness: { recovery_hours: 5, sleep_hours: 6 },
        today_training_context: {
          whoop_total_strain_today: 9.5,
          tonal_sessions_today: 1,
        },
        today_training_recommendation: {
          mode: "controlled_train",
        },
        today_mission: {
          mission_key: "spartan:2026-04-05:yellow:controlled_train",
          nutrition: {
            protein_actual_g: 92,
            protein_target_g: 130,
          },
        },
      },
      eveningArtifact: {
        today_nutrition: {
          protein_g: 110,
          protein_target_g: { min: 112 },
        },
      },
      daySignals: {
        checkin_count: 1,
        pain_flag: true,
        soreness_score: 7,
        schedule_constraint: "travel",
      },
    });

    expect(input.readinessBand).toBe("yellow");
    expect(input.riskFlags).toContain("hrv_down_vs_baseline");
    expect(input.plannedIntensity).toBe("moderate");
    expect(input.painFlag).toBe(true);
    expect(input.scheduleConstraint).toBe("travel");
    expect(input.proteinTargetG).toBe(130);
  });

  it("chooses the highest-severity alert as primary", () => {
    const primary = selectPrimaryAlert([
      {
        alert_key: "a",
        alert_type: "protein_miss",
        severity: "warning",
        title: "Protein gap",
        summary: "Protein is low.",
        context: {},
        should_deliver: true,
      },
      {
        alert_key: "b",
        alert_type: "pain",
        severity: "high",
        title: "Pain flag",
        summary: "Pain overrides progression.",
        context: {},
        should_deliver: true,
      },
    ]);

    expect(primary?.alert_key).toBe("b");
    expect(primary?.severity).toBe("high");
  });
});
