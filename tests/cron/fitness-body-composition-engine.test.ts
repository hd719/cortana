import { describe, expect, it } from "vitest";

import {
  buildWeeklyBodyWeightTrend,
  selectPreferredMetricForDate,
} from "../../tools/fitness/body-composition-engine.ts";
import type { HealthSourceDailyRow } from "../../tools/fitness/health-source-db.ts";
import { assessGoalModeProgress } from "../../tools/fitness/goal-mode.ts";

describe("fitness body composition engine", () => {
  const healthRows: HealthSourceDailyRow[] = [
    {
      metric_date: "2026-04-05",
      metric_name: "body_weight_kg",
      source_name: "apple_health",
      metric_value: 84.1,
      unit: "kg",
      freshness_hours: 2,
      source_confidence: 0.95,
      provenance: { source: "apple" },
    },
    {
      metric_date: "2026-04-05",
      metric_name: "steps",
      source_name: "apple_health",
      metric_value: 12450,
      unit: "count",
      freshness_hours: 2,
      source_confidence: 0.94,
      provenance: { source: "apple" },
    },
    {
      metric_date: "2026-04-05",
      metric_name: "steps",
      source_name: "whoop",
      metric_value: 9800,
      unit: "count",
      freshness_hours: 1,
      source_confidence: 0.7,
      provenance: { source: "whoop" },
    },
    {
      metric_date: "2026-04-04",
      metric_name: "body_weight_kg",
      source_name: "apple_health",
      metric_value: 84.4,
      unit: "kg",
      freshness_hours: 26,
      source_confidence: 0.9,
      provenance: {},
    },
    {
      metric_date: "2026-04-03",
      metric_name: "body_weight_kg",
      source_name: "apple_health",
      metric_value: 84.5,
      unit: "kg",
      freshness_hours: 50,
      source_confidence: 0.88,
      provenance: {},
    },
    {
      metric_date: "2026-03-30",
      metric_name: "body_weight_kg",
      source_name: "apple_health",
      metric_value: 85.2,
      unit: "kg",
      freshness_hours: 10,
      source_confidence: 0.92,
      provenance: {},
    },
    {
      metric_date: "2026-03-29",
      metric_name: "body_weight_kg",
      source_name: "apple_health",
      metric_value: 85.4,
      unit: "kg",
      freshness_hours: 8,
      source_confidence: 0.92,
      provenance: {},
    },
    {
      metric_date: "2026-03-28",
      metric_name: "body_weight_kg",
      source_name: "apple_health",
      metric_value: 85.5,
      unit: "kg",
      freshness_hours: 6,
      source_confidence: 0.92,
      provenance: {},
    },
    {
      metric_date: "2026-03-27",
      metric_name: "body_weight_kg",
      source_name: "apple_health",
      metric_value: 85.6,
      unit: "kg",
      freshness_hours: 6,
      source_confidence: 0.92,
      provenance: {},
    },
  ];

  it("prefers fresh Apple Health rows for steps and body weight", () => {
    const bodyWeight = selectPreferredMetricForDate({
      metricName: "body_weight_kg",
      metricDate: "2026-04-05",
      healthRows,
      fallbackValue: 85,
      fallbackSource: "whoop",
      fallbackConfidence: 0.6,
      fallbackUnit: "kg",
    });
    const steps = selectPreferredMetricForDate({
      metricName: "steps",
      metricDate: "2026-04-05",
      healthRows,
      fallbackValue: 9800,
      fallbackSource: "whoop",
      fallbackConfidence: 0.7,
      fallbackUnit: "count",
    });

    expect(bodyWeight.value).toBe(84.1);
    expect(bodyWeight.source).toBe("apple_health");
    expect(bodyWeight.usedFallback).toBe(false);
    expect(steps.value).toBe(12450);
    expect(steps.source).toBe("apple_health");
  });

  it("falls back when the health row is too stale or missing", () => {
    const selection = selectPreferredMetricForDate({
      metricName: "active_energy_kcal",
      metricDate: "2026-04-05",
      healthRows,
      fallbackValue: 640,
      fallbackSource: "estimated",
      fallbackConfidence: 0.4,
      fallbackUnit: "kcal",
    });

    expect(selection.value).toBe(640);
    expect(selection.usedFallback).toBe(true);
    expect(selection.qualityFlags).toContain("health_source_missing");
  });

  it("builds a weekly body-weight trend and phase progress assessment", () => {
    const trend = buildWeeklyBodyWeightTrend({
      endDate: "2026-04-05",
      healthRows,
    });
    const assessment = assessGoalModeProgress({
      phaseMode: "gentle_cut",
      actualWeightDeltaPctWeek: trend.deltaPct,
      confidence: trend.confidence,
    });

    expect(trend.deltaPct).toBeLessThan(0);
    expect(trend.daysCurrent).toBeGreaterThanOrEqual(3);
    expect(trend.daysPrevious).toBeGreaterThanOrEqual(3);
    expect(assessment.phaseMode).toBe("gentle_cut");
    expect(["on_pace", "too_fast", "too_slow"]).toContain(assessment.status);
  });

  it("returns unknown goal-mode status when confidence is weak", () => {
    const assessment = assessGoalModeProgress({
      phaseMode: "lean_gain",
      actualWeightDeltaPctWeek: 0.1,
      confidence: 0.2,
    });

    expect(assessment.status).toBe("unknown");
  });
});
