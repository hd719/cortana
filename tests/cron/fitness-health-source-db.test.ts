import { describe, expect, it } from "vitest";
import {
  buildFetchHealthSourceRowsStatement,
  buildHealthSourceDailySchemaSql,
  buildHealthSourceDailyUpsertStatement,
  normalizeHealthSourcePayload,
} from "../../tools/fitness/health-source-db.ts";

describe("fitness health source DB helpers", () => {
  it("builds the normalized health source schema", () => {
    const schema = buildHealthSourceDailySchemaSql();

    expect(schema).toContain("CREATE TABLE IF NOT EXISTS cortana_fitness_health_source_daily");
    expect(schema).toContain("metric_date DATE NOT NULL");
    expect(schema).toContain("metric_name TEXT NOT NULL");
    expect(schema).toContain("source_name TEXT NOT NULL");
    expect(schema).toContain("metric_value NUMERIC(12,3) NOT NULL");
    expect(schema).toContain("freshness_hours NUMERIC(8,2)");
    expect(schema).toContain("source_confidence NUMERIC(4,3)");
    expect(schema).toContain("provenance JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(schema).toContain("PRIMARY KEY (metric_date, metric_name, source_name)");
    expect(schema).toContain("idx_health_source_daily_metric_date");
    expect(schema).toContain("idx_health_source_daily_metric_name");
    expect(schema).toContain("idx_health_source_daily_source_name");
  });

  it("normalizes already-canonical daily rows from the local health service payload", () => {
    const result = normalizeHealthSourcePayload(
      {
        exported_at: "2026-04-05T16:00:00Z",
        source: "apple_health_shortcut_v1",
        source_version: "1.2.3",
        provenance: {
          file_path: "/Users/hd/Desktop/training/latest.json",
          exporter: "shortcut",
        },
        rows: [
          {
            metric_date: "2026-04-04",
            metric_name: "body_weight_kg",
            metric_value: 78.4,
            unit: "kg",
            freshness_hours: 3.5,
            source_confidence: 0.94,
            provenance: {
              sample_id: "w1",
            },
          },
          {
            metric_date: "2026-04-04",
            metric_name: "steps",
            metric_value: "10432",
            unit: "count",
          },
          {
            metric_date: "2026-04-04",
            metric_name: "vo2_max",
            metric_value: 42,
            unit: "ml/kg/min",
          },
        ],
      },
      { ingestedAt: "2026-04-05T19:30:00Z" },
    );

    expect(result.summary.payloadKind).toBe("normalized_rows");
    expect(result.summary.sourceName).toBe("apple_health");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      metricDate: "2026-04-04",
      metricName: "body_weight_kg",
      sourceName: "apple_health",
      metricValue: 78.4,
      unit: "kg",
      freshnessHours: 3.5,
      sourceConfidence: 0.94,
    });
    expect(result.rows[0].provenance).toMatchObject({
      source: {
        canonical: "apple_health",
        input: "apple_health_shortcut_v1",
        version: "1.2.3",
      },
      export: {
        exported_at: "2026-04-05T16:00:00Z",
        ingested_at: "2026-04-05T19:30:00Z",
        freshness_hours: 3.5,
        kind: "normalized_rows",
      },
    });
    expect(result.ignoredMetrics).toHaveLength(1);
    expect(result.ignoredMetrics[0]).toMatchObject({
      metricDate: "2026-04-04",
      metricName: "vo2_max",
      sourceName: "apple_health",
      reason: "unsupported_metric",
    });
  });

  it("expands a raw daily export payload into canonical health metric rows", () => {
    const result = normalizeHealthSourcePayload(
      {
        exportedAt: "2026-04-05T12:00:00-04:00",
        source_name: "apple_health",
        days: [
          {
            date: "2026-04-04",
            bodyWeightKg: 78.1,
            steps: "10400",
            active_energy_kcal: 612,
            metrics: {
              restingEnergyKcal: 1844,
              walking_running_distance_km: 7.9,
              bodyFatPct: 14.2,
              lean_mass_kg: 63.5,
              vo2_max: 42,
            },
            sourceConfidence: 0.91,
            provenance: {
              file_path: "/tmp/latest.json",
            },
          },
        ],
      },
      { ingestedAt: "2026-04-05T15:00:00-04:00" },
    );

    expect(result.summary.payloadKind).toBe("daily_export");
    expect(result.rows).toHaveLength(7);
    expect(result.rows.map((row) => row.metricName)).toEqual([
      "body_weight_kg",
      "steps",
      "active_energy_kcal",
      "resting_energy_kcal",
      "walking_running_distance_km",
      "body_fat_pct",
      "lean_mass_kg",
    ]);
    expect(result.rows[0]).toMatchObject({
      metricDate: "2026-04-04",
      metricName: "body_weight_kg",
      sourceName: "apple_health",
      metricValue: 78.1,
      unit: "kg",
      freshnessHours: 3,
      sourceConfidence: 0.91,
    });
    expect(result.ignoredMetrics).toHaveLength(1);
    expect(result.ignoredMetrics[0]).toMatchObject({
      metricDate: "2026-04-04",
      metricName: "vo2_max",
      reason: "unsupported_metric",
    });
  });

  it("builds a safe health source upsert statement", () => {
    const sql = buildHealthSourceDailyUpsertStatement({
      metricDate: "2026-04-04",
      metricName: "body_weight_kg",
      sourceName: "apple_health",
      metricValue: 78.4,
      unit: "kg",
      freshnessHours: 3.5,
      sourceConfidence: 0.94,
      provenance: {
        file_path: "/Users/hd/Desktop/training/O'Brien/latest.json",
        exporter: "shortcut",
      },
    });

    expect(sql).toContain("INSERT INTO cortana_fitness_health_source_daily");
    expect(sql).toContain("ON CONFLICT (metric_date, metric_name, source_name) DO UPDATE");
    expect(sql).toContain("COALESCE(cortana_fitness_health_source_daily.provenance, '{}'::jsonb) || COALESCE(EXCLUDED.provenance, '{}'::jsonb)");
    expect(sql).toContain("O''Brien");
  });

  it("builds a health source fetch statement for a metric window", () => {
    const sql = buildFetchHealthSourceRowsStatement("2026-04-01", "2026-04-07", "body_weight_kg");

    expect(sql).toContain("cortana_fitness_health_source_daily");
    expect(sql).toContain("metric_date BETWEEN '2026-04-01'::date AND '2026-04-07'::date");
    expect(sql).toContain("metric_name = 'body_weight_kg'");
  });
});
