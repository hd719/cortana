import { describe, expect, it, vi } from "vitest";

import { loadAppleHealthWindow } from "../../tools/fitness/health-source-service.ts";

describe("fitness apple health service loader", () => {
  it("ingests service data and returns the persisted health window", () => {
    const fetchJson = vi.fn((url: string) => {
      if (url.endsWith("/health")) {
        return { status: "healthy" };
      }
      return {
        generated_at: "2026-04-05T10:00:00Z",
        days: [
          {
            date: "2026-04-05",
            bodyWeightKg: 78.4,
            steps: 10432,
          },
        ],
      };
    });
    const ingestPayload = vi.fn(() => ({
      rows: [
        {
          metricDate: "2026-04-05",
          metricName: "body_weight_kg",
          sourceName: "apple_health",
          metricValue: 78.4,
          unit: "kg",
          freshnessHours: 2,
          sourceConfidence: 0.92,
          provenance: {},
        },
      ],
      ignoredMetrics: [],
      summary: {
        sourceName: "apple_health",
        exportedAt: "2026-04-05T10:00:00Z",
        ingestedAt: "2026-04-05T12:00:00Z",
        rowCount: 1,
        ignoredCount: 0,
        payloadKind: "daily_export" as const,
      },
      writeResult: { ok: true, rowsWritten: 1 },
    }));
    const fetchRows = vi.fn(() => [
      {
        metric_date: "2026-04-05",
        metric_name: "body_weight_kg",
        source_name: "apple_health",
        metric_value: 78.4,
        unit: "kg",
        freshness_hours: 2,
        source_confidence: 0.92,
        provenance: {},
      },
    ]);

    const result = loadAppleHealthWindow({
      endDate: "2026-04-05",
      ingestedAt: "2026-04-05T12:00:00Z",
      fetchJson,
      ingestPayload,
      fetchRows,
    });

    expect(result.serviceStatus).toBe("healthy");
    expect(result.ingestedRowCount).toBe(1);
    expect(result.healthRows).toHaveLength(1);
    expect(fetchRows).toHaveBeenCalledWith("2026-03-23", "2026-04-05");
  });

  it("returns a clear error when the local service responds with a real unhealthy payload", () => {
    const result = loadAppleHealthWindow({
      endDate: "2026-04-05",
      fetchJson: (url) =>
        url.endsWith("/health") ? { status: "unhealthy" } : { error: "invalid apple health export schema" },
      ingestPayload: vi.fn(),
      fetchRows: vi.fn(() => []),
    });

    expect(result.serviceStatus).toBe("unhealthy");
    expect(result.healthRows).toEqual([]);
    expect(result.ingestedRowCount).toBe(0);
    expect(result.error).toBe("invalid apple health export schema");
  });

  it("treats an unconfigured Apple Health export as optional", () => {
    const fetchRows = vi.fn(() => [
      {
        metric_date: "2026-04-04",
        metric_name: "body_weight_kg",
        source_name: "apple_health",
        metric_value: 78.1,
        unit: "kg",
        freshness_hours: 24,
        source_confidence: 0.7,
        provenance: {},
      },
    ]);

    const result = loadAppleHealthWindow({
      endDate: "2026-04-05",
      fetchJson: (url) =>
        url.endsWith("/health")
          ? { status: "unconfigured", note: "apple health export not configured" }
          : { status: "unconfigured", data_path: "/tmp/apple-health.json" },
      ingestPayload: vi.fn(),
      fetchRows,
    });

    expect(result.serviceStatus).toBe("unconfigured");
    expect(result.healthRows).toHaveLength(1);
    expect(result.ingestedRowCount).toBe(0);
    expect(result.error).toBeNull();
    expect(fetchRows).toHaveBeenCalledWith("2026-03-23", "2026-04-05");
  });

  it("can return the in-memory normalized rows without hitting the DB", () => {
    const result = loadAppleHealthWindow({
      endDate: "2026-04-05",
      persist: false,
      fetchJson: (url) =>
        url.endsWith("/health")
          ? { status: "degraded" }
          : {
              generated_at: "2026-04-05T10:00:00Z",
              days: [{ date: "2026-04-05", active_energy_kcal: 640 }],
            },
      ingestPayload: () => ({
        rows: [
          {
            metricDate: "2026-04-05",
            metricName: "active_energy_kcal",
            sourceName: "apple_health",
            metricValue: 640,
            unit: "kcal",
            freshnessHours: 3,
            sourceConfidence: 0.8,
            provenance: {},
          },
        ],
        ignoredMetrics: [],
        summary: {
          sourceName: "apple_health",
          exportedAt: "2026-04-05T10:00:00Z",
          ingestedAt: "2026-04-05T13:00:00Z",
          rowCount: 1,
          ignoredCount: 0,
          payloadKind: "daily_export",
        },
        writeResult: null,
      }),
      fetchRows: vi.fn(() => {
        throw new Error("should not query db when persist=false");
      }),
    });

    expect(result.serviceStatus).toBe("degraded");
    expect(result.healthRows).toEqual([
      {
        metric_date: "2026-04-05",
        metric_name: "active_energy_kcal",
        source_name: "apple_health",
        metric_value: 640,
        unit: "kcal",
        freshness_hours: 3,
        source_confidence: 0.8,
        provenance: {},
      },
    ]);
  });
});
