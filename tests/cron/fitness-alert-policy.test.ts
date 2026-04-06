import { describe, expect, it } from "vitest";
import { buildAlertKey, dedupeAlertDecisions, evaluateAlertPolicy } from "../../tools/fitness/alert-policy.ts";

describe("fitness alert policy", () => {
  it("builds stable keys from equivalent contexts", () => {
    const keyA = buildAlertKey({
      alertType: "protein_miss",
      dateLocal: "2026-04-05",
      context: { b: 2, a: 1 },
    });
    const keyB = buildAlertKey({
      alertType: "protein_miss",
      dateLocal: "2026-04-05",
      context: { a: 1, b: 2 },
    });

    expect(keyA).toBe(keyB);
  });

  it("evaluates a full set of alerts with deterministic severity", () => {
    const alerts = evaluateAlertPolicy({
      dateLocal: "2026-04-05",
      missionKey: "spartan:2026-04-05:red:rest_and_recover",
      readinessBand: "red",
      dataFreshnessHours: { recovery: 22, sleep: 19 },
      riskFlags: ["low_recovery", "hrv_down_vs_baseline"],
      totalStrainToday: 18.2,
      tonalSessionsToday: 2,
      proteinActualG: 92,
      proteinTargetG: 130,
      painFlag: true,
      sorenessScore: 7,
      scheduleConstraint: "travel window only",
      plannedIntensity: "hard",
    });

    const types = alerts.map((alert) => alert.alert_type);
    expect(types).toEqual([
      "freshness",
      "recovery_risk",
      "overreach",
      "protein_miss",
      "pain",
      "schedule_conflict",
    ]);
    expect(alerts.find((alert) => alert.alert_type === "freshness")?.severity).toBe("high");
    expect(alerts.find((alert) => alert.alert_type === "protein_miss")?.severity).toBe("warning");
    expect(alerts.find((alert) => alert.alert_type === "pain")?.severity).toBe("high");
  });

  it("dedupes repeated alerts by keeping the highest severity", () => {
    const base = evaluateAlertPolicy({
      dateLocal: "2026-04-05",
      readinessBand: "yellow",
      totalStrainToday: 12,
      proteinActualG: null,
      proteinTargetG: 130,
      scheduleConstraint: "short session",
      plannedIntensity: "moderate",
    });
    const duplicate = {
      ...base[0],
      severity: "high" as const,
      context: { ...base[0].context, source: "manual" },
    };

    const deduped = dedupeAlertDecisions([base[0], duplicate]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].severity).toBe("high");
    expect(deduped[0].context).toMatchObject({ source: "manual" });
  });

  it("raises freshness alerts from the reliability guardrail even without explicit stale hours", () => {
    const alerts = evaluateAlertPolicy({
      dateLocal: "2026-04-06",
      missionKey: "spartan:2026-04-06:guardrail",
      readinessBand: "unknown",
      guardrailStatus: "block",
      guardrailReasonCodes: ["whoop_recovery_missing", "readiness_blind_spot"],
      dataFreshnessHours: {
        recovery: null,
        sleep: null,
      },
    });

    expect(alerts[0]).toMatchObject({
      alert_type: "freshness",
      severity: "high",
    });
    expect(alerts[0]?.context).toMatchObject({
      guardrail_status: "block",
      guardrail_reason_codes: ["whoop_recovery_missing", "readiness_blind_spot"],
    });
  });
});
