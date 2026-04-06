import { spawnSync } from "node:child_process";
import {
  fetchHealthSourceRows,
  ingestHealthSourcePayload,
  type HealthSourceDailyRow,
  type HealthSourceIngestResult,
  type HealthSourceUpsertResult,
} from "./health-source-db.js";

type JsonObject = Record<string, unknown>;

export type AppleHealthServiceStatus = "healthy" | "degraded" | "unhealthy" | "unconfigured" | "unknown";

export type AppleHealthWindowLoadResult = {
  serviceStatus: AppleHealthServiceStatus;
  healthRows: HealthSourceDailyRow[];
  ingestedRowCount: number;
  ignoredMetricCount: number;
  writeResult: HealthSourceUpsertResult | null;
  error: string | null;
};

export type ExternalJsonFetcher = (url: string, timeoutSec: number) => unknown;

function curlJson(url: string, timeoutSec: number): unknown {
  const result = spawnSync("curl", ["-s", "--max-time", String(timeoutSec), url], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if ((result.status ?? 1) !== 0) return {};
  try {
    return JSON.parse((result.stdout ?? "").trim() || "{}");
  } catch {
    return {};
  }
}

function toObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function daysBefore(dateYmd: string, days: number): string {
  const anchor = new Date(`${dateYmd}T12:00:00Z`);
  if (Number.isNaN(anchor.getTime())) return dateYmd;
  anchor.setUTCDate(anchor.getUTCDate() - days);
  return anchor.toISOString().slice(0, 10);
}

function serviceStatusFromHealthPayload(payload: unknown): AppleHealthServiceStatus {
  const status = toObject(payload).status;
  return status === "healthy" || status === "degraded" || status === "unhealthy" || status === "unconfigured"
    ? status
    : "unknown";
}

function isMissingAppleHealthExportError(value: unknown): boolean {
  return typeof value === "string" && /apple health export not found/i.test(value);
}

type IngestPayloadFn = (
  payload: unknown,
  options?: { ingestedAt?: string | null; persist?: boolean },
) => HealthSourceIngestResult & { writeResult: HealthSourceUpsertResult | null };

type FetchRowsFn = (startYmd: string, endYmd: string) => HealthSourceDailyRow[];

export function loadAppleHealthWindow(opts: {
  endDate: string;
  lookbackDays?: number;
  baseUrl?: string;
  ingestedAt?: string;
  persist?: boolean;
  fetchJson?: ExternalJsonFetcher;
  ingestPayload?: IngestPayloadFn;
  fetchRows?: FetchRowsFn;
}): AppleHealthWindowLoadResult {
  const lookbackDays = Math.max(0, opts.lookbackDays ?? 13);
  const startDate = daysBefore(opts.endDate, lookbackDays);
  const fetchJson = opts.fetchJson ?? curlJson;
  const ingestPayload = opts.ingestPayload ?? ingestHealthSourcePayload;
  const fetchRows = opts.fetchRows ?? ((startYmd, endYmd) => fetchHealthSourceRows(startYmd, endYmd));
  const baseUrl = (opts.baseUrl ?? "http://127.0.0.1:3033").replace(/\/+$/, "");
  const ingestedAt = opts.ingestedAt ?? new Date().toISOString();

  const healthPayload = fetchJson(`${baseUrl}/apple-health/health`, 5);
  const serviceStatus = serviceStatusFromHealthPayload(healthPayload);
  const dataPayload = fetchJson(`${baseUrl}/apple-health/data`, 12);
  const dataObject = toObject(dataPayload);
  const dataStatus = typeof dataObject.status === "string" ? dataObject.status : null;
  const dataError = typeof dataObject.error === "string" ? dataObject.error : null;

  if (serviceStatus === "unconfigured" || dataStatus === "unconfigured") {
    return {
      serviceStatus: "unconfigured",
      healthRows: fetchRows(startDate, opts.endDate),
      ingestedRowCount: 0,
      ignoredMetricCount: 0,
      writeResult: null,
      error: null,
    };
  }

  if (dataError && dataError.length > 0) {
    if (isMissingAppleHealthExportError(dataError)) {
      return {
        serviceStatus: "unconfigured",
        healthRows: fetchRows(startDate, opts.endDate),
        ingestedRowCount: 0,
        ignoredMetricCount: 0,
        writeResult: null,
        error: null,
      };
    }
    return {
      serviceStatus,
      healthRows: fetchRows(startDate, opts.endDate),
      ingestedRowCount: 0,
      ignoredMetricCount: 0,
      writeResult: null,
      error: dataError,
    };
  }

  if (Object.keys(dataObject).length === 0) {
    return {
      serviceStatus,
      healthRows: fetchRows(startDate, opts.endDate),
      ingestedRowCount: 0,
      ignoredMetricCount: 0,
      writeResult: null,
      error: serviceStatus === "unhealthy" ? "apple_health_service_unhealthy" : null,
    };
  }

  const ingestResult = ingestPayload(dataObject, {
    ingestedAt,
    persist: opts.persist ?? true,
  });
  const healthRows =
    opts.persist === false
      ? ingestResult.rows
          .filter((row) => row.metricDate >= startDate && row.metricDate <= opts.endDate)
          .map((row) => ({
            metric_date: row.metricDate,
            metric_name: row.metricName,
            source_name: row.sourceName,
            metric_value: row.metricValue,
            unit: row.unit ?? null,
            freshness_hours: row.freshnessHours ?? null,
            source_confidence: row.sourceConfidence ?? null,
            provenance: row.provenance ?? {},
          }))
      : fetchRows(startDate, opts.endDate);

  return {
    serviceStatus,
    healthRows,
    ingestedRowCount: ingestResult.rows.length,
    ignoredMetricCount: ingestResult.ignoredMetrics.length,
    writeResult: ingestResult.writeResult,
    error: null,
  };
}
