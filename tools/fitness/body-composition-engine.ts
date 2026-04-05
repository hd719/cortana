import { fetchHealthSourceRows, type HealthMetricName, type HealthSourceDailyRow } from "./health-source-db.js";

export type PreferredMetricSelection = {
  metricName: HealthMetricName;
  value: number | null;
  unit: string | null;
  source: string | null;
  confidence: number | null;
  usedFallback: boolean;
  qualityFlags: string[];
  provenance: Record<string, unknown> | null;
};

export type WeeklyBodyWeightTrend = {
  startDate: string;
  endDate: string;
  daysCurrent: number;
  daysPrevious: number;
  avgBodyWeightKgCurrent: number | null;
  avgBodyWeightKgPrevious: number | null;
  deltaKg: number | null;
  deltaPct: number | null;
  confidence: number;
  source: string | null;
  qualityFlags: string[];
};

type MetricRule = {
  preferredSources: string[];
  freshnessHoursMax: number;
  minConfidence: number;
  unit: string;
};

const METRIC_RULES: Record<HealthMetricName, MetricRule> = {
  body_weight_kg: {
    preferredSources: ["manual_override", "apple_health", "whoop"],
    freshnessHoursMax: 96,
    minConfidence: 0.55,
    unit: "kg",
  },
  steps: {
    preferredSources: ["apple_health", "manual_override", "whoop"],
    freshnessHoursMax: 48,
    minConfidence: 0.5,
    unit: "count",
  },
  active_energy_kcal: {
    preferredSources: ["apple_health", "manual_override"],
    freshnessHoursMax: 48,
    minConfidence: 0.45,
    unit: "kcal",
  },
  resting_energy_kcal: {
    preferredSources: ["apple_health", "manual_override"],
    freshnessHoursMax: 72,
    minConfidence: 0.45,
    unit: "kcal",
  },
  walking_running_distance_km: {
    preferredSources: ["apple_health", "manual_override"],
    freshnessHoursMax: 48,
    minConfidence: 0.45,
    unit: "km",
  },
  body_fat_pct: {
    preferredSources: ["apple_health", "manual_override"],
    freshnessHoursMax: 168,
    minConfidence: 0.4,
    unit: "pct",
  },
  lean_mass_kg: {
    preferredSources: ["apple_health", "manual_override"],
    freshnessHoursMax: 168,
    minConfidence: 0.4,
    unit: "kg",
  },
};

function toFixedNumber(value: number | null, digits = 3): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function daysBefore(dateYmd: string, days: number): string {
  const anchor = new Date(`${dateYmd}T12:00:00Z`);
  if (Number.isNaN(anchor.getTime())) return dateYmd;
  anchor.setUTCDate(anchor.getUTCDate() - days);
  return anchor.toISOString().slice(0, 10);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

function rowPriority(row: HealthSourceDailyRow, metricName: HealthMetricName): number {
  const rule = METRIC_RULES[metricName];
  const sourcePriority = rule.preferredSources.indexOf(row.source_name);
  return sourcePriority >= 0 ? sourcePriority : rule.preferredSources.length + 1;
}

function sortMetricRows(rows: HealthSourceDailyRow[], metricName: HealthMetricName): HealthSourceDailyRow[] {
  return [...rows].sort((left, right) => {
    const priorityDelta = rowPriority(left, metricName) - rowPriority(right, metricName);
    if (priorityDelta !== 0) return priorityDelta;
    const freshnessDelta = (left.freshness_hours ?? 9999) - (right.freshness_hours ?? 9999);
    if (freshnessDelta !== 0) return freshnessDelta;
    const confidenceDelta = (right.source_confidence ?? 0) - (left.source_confidence ?? 0);
    if (confidenceDelta !== 0) return confidenceDelta;
    return left.source_name.localeCompare(right.source_name);
  });
}

export function selectPreferredMetricForDate(input: {
  metricName: HealthMetricName;
  metricDate: string;
  healthRows: HealthSourceDailyRow[];
  fallbackValue?: number | null;
  fallbackSource?: string | null;
  fallbackConfidence?: number | null;
  fallbackUnit?: string | null;
}): PreferredMetricSelection {
  const rule = METRIC_RULES[input.metricName];
  const rows = sortMetricRows(
    input.healthRows.filter((row) => row.metric_date === input.metricDate && row.metric_name === input.metricName),
    input.metricName,
  );
  const qualityFlags: string[] = [];

  const healthyRow = rows.find((row) => {
    const freshnessOk = (row.freshness_hours ?? 9999) <= rule.freshnessHoursMax;
    const confidenceOk = (row.source_confidence ?? 0) >= rule.minConfidence;
    return freshnessOk && confidenceOk;
  });
  if (healthyRow) {
    return {
      metricName: input.metricName,
      value: healthyRow.metric_value,
      unit: healthyRow.unit,
      source: healthyRow.source_name,
      confidence: healthyRow.source_confidence ?? null,
      usedFallback: false,
      qualityFlags,
      provenance: healthyRow.provenance,
    };
  }

  const bestAvailable = rows[0] ?? null;
  if (bestAvailable) {
    if ((bestAvailable.freshness_hours ?? 9999) > rule.freshnessHoursMax) qualityFlags.push("stale_health_source");
    if ((bestAvailable.source_confidence ?? 0) < rule.minConfidence) qualityFlags.push("low_confidence_health_source");
  }

  if (input.fallbackValue != null) {
    qualityFlags.push(bestAvailable ? "used_fallback_over_health_source" : "health_source_missing");
    return {
      metricName: input.metricName,
      value: input.fallbackValue,
      unit: input.fallbackUnit ?? rule.unit,
      source: input.fallbackSource ?? null,
      confidence: input.fallbackConfidence ?? null,
      usedFallback: true,
      qualityFlags,
      provenance: bestAvailable?.provenance ?? null,
    };
  }

  return {
    metricName: input.metricName,
    value: bestAvailable?.metric_value ?? null,
    unit: bestAvailable?.unit ?? null,
    source: bestAvailable?.source_name ?? null,
    confidence: bestAvailable?.source_confidence ?? null,
    usedFallback: false,
    qualityFlags: bestAvailable ? qualityFlags : ["health_source_missing"],
    provenance: bestAvailable?.provenance ?? null,
  };
}

export function buildWeeklyBodyWeightTrend(input: {
  endDate: string;
  healthRows: HealthSourceDailyRow[];
}): WeeklyBodyWeightTrend {
  const currentStart = daysBefore(input.endDate, 6);
  const previousStart = daysBefore(input.endDate, 13);
  const previousEnd = daysBefore(input.endDate, 7);

  const selectWeight = (date: string): PreferredMetricSelection => selectPreferredMetricForDate({
    metricName: "body_weight_kg",
    metricDate: date,
    healthRows: input.healthRows,
  });

  const currentDates = Array.from({ length: 7 }, (_, index) => daysBefore(input.endDate, 6 - index));
  const previousDates = Array.from({ length: 7 }, (_, index) => daysBefore(previousEnd, 6 - index));
  const currentSelections = currentDates.map(selectWeight).filter((selection) => selection.value != null);
  const previousSelections = previousDates.map(selectWeight).filter((selection) => selection.value != null);

  const currentValues = currentSelections.map((selection) => selection.value as number);
  const previousValues = previousSelections.map((selection) => selection.value as number);
  const avgCurrent = average(currentValues);
  const avgPrevious = average(previousValues);
  const deltaKg = avgCurrent != null && avgPrevious != null ? toFixedNumber(avgCurrent - avgPrevious, 3) : null;
  const deltaPct = avgCurrent != null && avgPrevious != null && avgPrevious !== 0
    ? toFixedNumber(((avgCurrent - avgPrevious) / avgPrevious) * 100, 3)
    : null;
  const qualityFlags: string[] = [];

  if (currentSelections.length < 3) qualityFlags.push("sparse_current_weight_series");
  if (previousSelections.length < 3) qualityFlags.push("sparse_previous_weight_series");
  if (deltaPct == null) qualityFlags.push("missing_weight_delta");

  const confidences = [...currentSelections, ...previousSelections]
    .map((selection) => selection.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const baseConfidence = confidences.length > 0
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : 0;
  const coveragePenalty = currentSelections.length >= 3 && previousSelections.length >= 3 ? 0 : 0.25;
  const confidence = Math.max(0, Math.min(0.98, Number((baseConfidence - coveragePenalty).toFixed(3))));
  const source = currentSelections[0]?.source ?? previousSelections[0]?.source ?? null;

  return {
    startDate: currentStart,
    endDate: input.endDate,
    daysCurrent: currentSelections.length,
    daysPrevious: previousSelections.length,
    avgBodyWeightKgCurrent: avgCurrent,
    avgBodyWeightKgPrevious: avgPrevious,
    deltaKg,
    deltaPct,
    confidence,
    source,
    qualityFlags,
  };
}

export function fetchWeeklyBodyWeightTrend(endDate: string): WeeklyBodyWeightTrend {
  const startDate = daysBefore(endDate, 13);
  const rows = fetchHealthSourceRows(startDate, endDate, "body_weight_kg");
  return buildWeeklyBodyWeightTrend({ endDate, healthRows: rows });
}
