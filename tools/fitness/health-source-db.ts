import { runPsql } from "../lib/db.js";

export type HealthSourceName =
  | "apple_health"
  | "whoop"
  | "manual_override"
  | (string & {});

export type HealthSourceMetricName =
  | "body_weight_kg"
  | "steps"
  | "active_energy_kcal"
  | "resting_energy_kcal"
  | "walking_running_distance_km"
  | "body_fat_pct"
  | "lean_mass_kg";

export type HealthMetricName = HealthSourceMetricName;

export type HealthSourceDailyRowInput = {
  metricDate: string;
  metricName: HealthSourceMetricName;
  sourceName: HealthSourceName;
  metricValue: number;
  unit?: string | null;
  freshnessHours?: number | null;
  sourceConfidence?: number | null;
  provenance?: Record<string, unknown> | null;
};

export type HealthSourceDailyRow = {
  metric_date: string;
  metric_name: HealthSourceMetricName;
  source_name: HealthSourceName;
  metric_value: number;
  unit: string | null;
  freshness_hours: number | null;
  source_confidence: number | null;
  provenance: Record<string, unknown>;
  created_at?: string;
};

export type HealthSourceIgnoredMetric = {
  metricDate: string | null;
  metricName: string;
  sourceName: HealthSourceName;
  reason: "missing_date" | "missing_value" | "invalid_value" | "unsupported_metric";
  provenance: Record<string, unknown>;
};

export type HealthSourceIngestSummary = {
  sourceName: HealthSourceName;
  exportedAt: string | null;
  ingestedAt: string;
  rowCount: number;
  ignoredCount: number;
  payloadKind: "normalized_rows" | "daily_export" | "single_row";
};

export type HealthSourceIngestResult = {
  rows: HealthSourceDailyRowInput[];
  ignoredMetrics: HealthSourceIgnoredMetric[];
  summary: HealthSourceIngestSummary;
};

export type HealthSourceUpsertResult = {
  ok: boolean;
  rowsWritten: number;
  error?: string;
};

type HealthSourcePayload = Record<string, unknown>;

type HealthSourceMetricSpec = {
  metricName: HealthSourceMetricName;
  unit: string;
};

const HEALTH_SOURCE_SCHEMA_LOCK_KEY = 624910117;
let healthSourceSchemaEnsured = false;
const SUPPORTED_METRICS: Record<string, HealthSourceMetricSpec> = {
  body_weight_kg: { metricName: "body_weight_kg", unit: "kg" },
  bodyWeightKg: { metricName: "body_weight_kg", unit: "kg" },
  weightKg: { metricName: "body_weight_kg", unit: "kg" },
  steps: { metricName: "steps", unit: "count" },
  step_count: { metricName: "steps", unit: "count" },
  stepCount: { metricName: "steps", unit: "count" },
  active_energy_kcal: { metricName: "active_energy_kcal", unit: "kcal" },
  activeEnergyKcal: { metricName: "active_energy_kcal", unit: "kcal" },
  resting_energy_kcal: { metricName: "resting_energy_kcal", unit: "kcal" },
  restingEnergyKcal: { metricName: "resting_energy_kcal", unit: "kcal" },
  walking_running_distance_km: { metricName: "walking_running_distance_km", unit: "km" },
  walkingRunningDistanceKm: { metricName: "walking_running_distance_km", unit: "km" },
  distanceKm: { metricName: "walking_running_distance_km", unit: "km" },
  body_fat_pct: { metricName: "body_fat_pct", unit: "pct" },
  bodyFatPct: { metricName: "body_fat_pct", unit: "pct" },
  bodyFatPercent: { metricName: "body_fat_pct", unit: "pct" },
  lean_mass_kg: { metricName: "lean_mass_kg", unit: "kg" },
  leanMassKg: { metricName: "lean_mass_kg", unit: "kg" },
};

const METRIC_ORDER: HealthSourceMetricName[] = [
  "body_weight_kg",
  "steps",
  "active_energy_kcal",
  "resting_energy_kcal",
  "walking_running_distance_km",
  "body_fat_pct",
  "lean_mass_kg",
];

const METADATA_KEYS = new Set([
  "date",
  "metric_date",
  "day",
  "local_date",
  "source",
  "source_name",
  "sourceName",
  "exported_at",
  "exportedAt",
  "ingested_at",
  "ingestedAt",
  "source_version",
  "sourceVersion",
  "confidence",
  "source_confidence",
  "sourceConfidence",
  "freshness_hours",
  "freshnessHours",
  "provenance",
  "metadata",
  "metrics",
  "rows",
  "days",
  "entries",
  "value",
  "metric_value",
  "metricValue",
  "unit",
  "metric_name",
  "metricName",
  "file_path",
  "filePath",
  "path",
  "export_id",
  "exportId",
  "notes",
  "kind",
  "schema_version",
  "schemaVersion",
  "payload",
  "export",
  "measurements",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

function sqlText(value: string | null | undefined): string {
  if (value == null || value.length === 0) return "NULL";
  return `'${esc(value)}'`;
}

function sqlNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "NULL";
  return String(value);
}

function sqlJson(value: Record<string, unknown> | null | undefined): string {
  if (!value || !isRecord(value)) return "'{}'::jsonb";
  return `'${esc(JSON.stringify(value))}'::jsonb`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function coerceString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseJsonValue<T>(raw: string, fallback: T): T {
  const text = String(raw ?? "").trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function coerceConfidence(value: unknown, fallback: number | null = null): number | null {
  const numeric = coerceNumber(value);
  if (numeric == null) return fallback;
  return round(Math.min(1, Math.max(0, numeric)), 3);
}

function coerceFreshnessHours(value: unknown): number | null {
  const numeric = coerceNumber(value);
  if (numeric == null) return null;
  return round(Math.max(0, numeric), 2);
}

function canonicalizeSourceName(value: unknown): HealthSourceName {
  const raw = coerceString(value);
  if (!raw) return "apple_health";
  const lower = raw.toLowerCase();
  if (lower.includes("apple") && lower.includes("health")) return "apple_health";
  if (lower.includes("whoop")) return "whoop";
  if (lower.includes("manual")) return "manual_override";
  return lower.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "apple_health";
}

function canonicalizeMetricName(value: unknown): { metricName: HealthSourceMetricName; unit: string } | null {
  const raw = coerceString(value);
  if (!raw) return null;
  const spec = SUPPORTED_METRICS[raw];
  if (spec) return spec;
  const lower = raw.toLowerCase();
  const alias = SUPPORTED_METRICS[raw.replace(/[\s-]+/g, "_")] ?? SUPPORTED_METRICS[lower];
  return alias ?? null;
}

function parseMetricValue(value: unknown): number | null {
  const numeric = coerceNumber(value);
  if (numeric == null) return null;
  return round(numeric, 3);
}

function resolveMetricDate(value: unknown): string | null {
  const raw = coerceString(value);
  if (!raw) return null;
  if (raw.length >= 10) return raw.slice(0, 10);
  return raw;
}

function payloadKind(payload: HealthSourcePayload): "normalized_rows" | "daily_export" | "single_row" {
  if (Array.isArray(payload.rows)) return "normalized_rows";
  if (Array.isArray(payload.days) || Array.isArray(payload.entries)) return "daily_export";
  return "single_row";
}

function payloadSourceName(payload: HealthSourcePayload): HealthSourceName {
  return canonicalizeSourceName(payload.source_name ?? payload.sourceName ?? payload.source);
}

function payloadExportedAt(payload: HealthSourcePayload): string | null {
  return coerceString(payload.exported_at ?? payload.exportedAt ?? payload.generated_at ?? payload.generatedAt);
}

function payloadSourceVersion(payload: HealthSourcePayload): string | null {
  return coerceString(payload.source_version ?? payload.sourceVersion ?? payload.version);
}

function payloadProvenance(payload: HealthSourcePayload): Record<string, unknown> {
  return isRecord(payload.provenance) ? payload.provenance : {};
}

function ingestFreshnessHours(exportedAt: string | null, ingestedAt: string): number | null {
  if (!exportedAt) return null;
  const exportedMs = Date.parse(exportedAt);
  const ingestedMs = Date.parse(ingestedAt);
  if (!Number.isFinite(exportedMs) || !Number.isFinite(ingestedMs)) return null;
  return round(Math.max(0, (ingestedMs - exportedMs) / 3_600_000), 2);
}

function baseProvenance(opts: {
  sourceName: HealthSourceName;
  sourceInput: string | null;
  sourceVersion: string | null;
  exportedAt: string | null;
  ingestedAt: string;
  payload: HealthSourcePayload;
  payloadKind: "normalized_rows" | "daily_export" | "single_row";
}): Record<string, unknown> {
  return {
    source: {
      canonical: opts.sourceName,
      input: opts.sourceInput,
      version: opts.sourceVersion,
    },
    export: {
      exported_at: opts.exportedAt,
      ingested_at: opts.ingestedAt,
      freshness_hours: ingestFreshnessHours(opts.exportedAt, opts.ingestedAt),
      kind: opts.payloadKind,
    },
    payload: payloadProvenance(opts.payload),
  };
}

function metricProvenance(opts: {
  base: Record<string, unknown>;
  metricSource: "normalized_row" | "day_field" | "metrics_object" | "metrics_array";
  metricInputName: string;
  metricName: HealthSourceMetricName;
  sourceConfidenceInput: unknown;
  rowIndex: number;
  rawKeys: string[];
  rowProvenance?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    ...opts.base,
    metric: {
      source: opts.metricSource,
      input_name: opts.metricInputName,
      canonical_name: opts.metricName,
      source_confidence_input: coerceConfidence(opts.sourceConfidenceInput, null),
      row_index: opts.rowIndex,
      raw_keys: opts.rawKeys,
      provenance: isRecord(opts.rowProvenance) ? opts.rowProvenance : {},
    },
  };
}

function toDailyRowInput(opts: {
  metricDate: string;
  metricName: HealthSourceMetricName;
  sourceName: HealthSourceName;
  metricValue: number;
  unit?: string | null;
  freshnessHours?: number | null;
  sourceConfidence?: number | null;
  provenance?: Record<string, unknown> | null;
}): HealthSourceDailyRowInput {
  return {
    metricDate: opts.metricDate,
    metricName: opts.metricName,
    sourceName: opts.sourceName,
    metricValue: round(opts.metricValue, 3),
    unit: opts.unit ?? null,
    freshnessHours: opts.freshnessHours == null ? null : round(opts.freshnessHours, 2),
    sourceConfidence: opts.sourceConfidence == null ? null : round(opts.sourceConfidence, 3),
    provenance: isRecord(opts.provenance) ? opts.provenance : {},
  };
}

function normalizedRowFromRecord(
  item: Record<string, unknown>,
  context: {
    payload: HealthSourcePayload;
    sourceName: HealthSourceName;
    sourceInput: string | null;
    sourceVersion: string | null;
    exportedAt: string | null;
    ingestedAt: string;
    payloadKind: "normalized_rows" | "daily_export" | "single_row";
    rowIndex: number;
    rowKind: "normalized_row" | "daily_export";
  },
): { row: HealthSourceDailyRowInput | null; ignored: HealthSourceIgnoredMetric | null } {
  const metricDate = resolveMetricDate(item.metric_date ?? item.metricDate ?? item.date ?? item.day ?? item.local_date);
  if (!metricDate) {
    return {
      row: null,
      ignored: {
        metricDate: null,
        metricName: coerceString(item.metric_name ?? item.metricName ?? item.name ?? "unknown") ?? "unknown",
        sourceName: context.sourceName,
        reason: "missing_date",
        provenance: metricProvenance({
          base: baseProvenance(context),
          metricSource: context.rowKind,
          metricInputName: coerceString(item.metric_name ?? item.metricName ?? item.name ?? "unknown") ?? "unknown",
          metricName: "steps",
          sourceConfidenceInput: item.source_confidence ?? item.sourceConfidence ?? item.confidence,
          rowIndex: context.rowIndex,
          rawKeys: Object.keys(item).sort(),
          rowProvenance: isRecord(item.provenance) ? item.provenance : null,
        }),
      },
    };
  }

  const normalizedMetricName = canonicalizeMetricName(item.metric_name ?? item.metricName ?? item.name);
  const rowFreshness = coerceFreshnessHours(item.freshness_hours ?? item.freshnessHours);
  const rowSourceConfidence = coerceConfidence(
    item.source_confidence ?? item.sourceConfidence ?? item.confidence ?? context.payload.source_confidence ?? context.payload.sourceConfidence ?? context.payload.confidence,
    null,
  );

  if (!normalizedMetricName) {
    const rawMetricName = coerceString(item.metric_name ?? item.metricName ?? item.name) ?? "unknown";
    const value = parseMetricValue(item.metric_value ?? item.metricValue ?? item.value);
    return {
      row: null,
      ignored: {
        metricDate,
        metricName: rawMetricName,
        sourceName: context.sourceName,
        reason: value == null ? "invalid_value" : "unsupported_metric",
        provenance: metricProvenance({
          base: baseProvenance(context),
          metricSource: context.rowKind,
          metricInputName: rawMetricName,
          metricName: "steps",
          sourceConfidenceInput: item.source_confidence ?? item.sourceConfidence ?? item.confidence,
          rowIndex: context.rowIndex,
          rawKeys: Object.keys(item).sort(),
          rowProvenance: isRecord(item.provenance) ? item.provenance : null,
        }),
      },
    };
  }

  const metricValue = parseMetricValue(item.metric_value ?? item.metricValue ?? item.value);
  if (metricValue == null) {
    return {
      row: null,
      ignored: {
        metricDate,
        metricName: normalizedMetricName.metricName,
        sourceName: context.sourceName,
        reason: "missing_value",
        provenance: metricProvenance({
          base: baseProvenance(context),
          metricSource: context.rowKind,
          metricInputName: coerceString(item.metric_name ?? item.metricName ?? item.name) ?? normalizedMetricName.metricName,
          metricName: normalizedMetricName.metricName,
          sourceConfidenceInput: item.source_confidence ?? item.sourceConfidence ?? item.confidence,
          rowIndex: context.rowIndex,
          rawKeys: Object.keys(item).sort(),
          rowProvenance: isRecord(item.provenance) ? item.provenance : null,
        }),
      },
    };
  }

  const unit = coerceString(item.unit) ?? normalizedMetricName.unit;
  const provenance = metricProvenance({
    base: baseProvenance(context),
    metricSource: context.rowKind,
    metricInputName: coerceString(item.metric_name ?? item.metricName ?? item.name) ?? normalizedMetricName.metricName,
    metricName: normalizedMetricName.metricName,
    sourceConfidenceInput: item.source_confidence ?? item.sourceConfidence ?? item.confidence,
    rowIndex: context.rowIndex,
    rawKeys: Object.keys(item).sort(),
    rowProvenance: isRecord(item.provenance) ? item.provenance : null,
  });

  return {
    row: toDailyRowInput({
      metricDate,
      metricName: normalizedMetricName.metricName,
      sourceName: context.sourceName,
      metricValue,
      unit,
      freshnessHours: rowFreshness ?? ingestFreshnessHours(context.exportedAt, context.ingestedAt),
      sourceConfidence: rowSourceConfidence,
      provenance,
    }),
    ignored: null,
  };
}

function expandDailyRecord(
  item: Record<string, unknown>,
  context: {
    payload: HealthSourcePayload;
    sourceName: HealthSourceName;
    sourceInput: string | null;
    sourceVersion: string | null;
    exportedAt: string | null;
    ingestedAt: string;
    payloadKind: "normalized_rows" | "daily_export" | "single_row";
    rowIndex: number;
  },
): HealthSourceIngestResult {
  const rowProvenance = isRecord(item.provenance) ? item.provenance : null;
  const base = baseProvenance(context);
  const rows: HealthSourceDailyRowInput[] = [];
  const ignoredMetrics: HealthSourceIgnoredMetric[] = [];

  const directKeys = new Set(Object.keys(item));
  const metricEntries: Array<{ source: "day_field" | "metrics_object" | "metrics_array"; name: string; value: unknown; unit?: unknown; provenance?: Record<string, unknown> | null }> = [];

  for (const [key, value] of Object.entries(item)) {
    if (METADATA_KEYS.has(key)) continue;
    const spec = canonicalizeMetricName(key);
    if (!spec) {
      if (value != null) {
        ignoredMetrics.push({
          metricDate: resolveMetricDate(item.metric_date ?? item.metricDate ?? item.date ?? item.day ?? item.local_date),
          metricName: key,
          sourceName: context.sourceName,
          reason: "unsupported_metric",
          provenance: metricProvenance({
            base,
            metricSource: "day_field",
            metricInputName: key,
            metricName: "steps",
            sourceConfidenceInput: item.source_confidence ?? item.sourceConfidence ?? item.confidence,
            rowIndex: context.rowIndex,
            rawKeys: Object.keys(item).sort(),
            rowProvenance,
          }),
        });
      }
      continue;
    }
    metricEntries.push({ source: "day_field", name: key, value, unit: spec.unit });
  }

  const metricsObject = isRecord(item.metrics) ? item.metrics : null;
  if (metricsObject) {
    for (const [key, value] of Object.entries(metricsObject)) {
      const spec = canonicalizeMetricName(key);
      if (!spec) {
        if (value != null) {
          ignoredMetrics.push({
            metricDate: resolveMetricDate(item.metric_date ?? item.metricDate ?? item.date ?? item.day ?? item.local_date),
            metricName: key,
            sourceName: context.sourceName,
            reason: "unsupported_metric",
            provenance: metricProvenance({
              base,
              metricSource: "metrics_object",
              metricInputName: key,
              metricName: "steps",
              sourceConfidenceInput: item.source_confidence ?? item.sourceConfidence ?? item.confidence,
              rowIndex: context.rowIndex,
              rawKeys: Object.keys(metricsObject).sort(),
              rowProvenance,
            }),
          });
        }
        continue;
      }
      metricEntries.push({ source: "metrics_object", name: key, value, unit: spec.unit, provenance: isRecord(metricsObject.provenance) ? metricsObject.provenance : null });
    }
  }

  const metricsArray = Array.isArray(item.measurements) ? item.measurements : Array.isArray(item.metric_values) ? item.metric_values : null;
  if (metricsArray) {
    for (const entry of metricsArray) {
      if (!isRecord(entry)) continue;
      const metricNameRaw = coerceString(entry.metric_name ?? entry.metricName ?? entry.name ?? entry.key);
      if (!metricNameRaw) {
        ignoredMetrics.push({
          metricDate: resolveMetricDate(item.metric_date ?? item.metricDate ?? item.date ?? item.day ?? item.local_date),
          metricName: "unknown",
          sourceName: context.sourceName,
          reason: "missing_value",
          provenance: metricProvenance({
            base,
            metricSource: "metrics_array",
            metricInputName: "unknown",
            metricName: "steps",
            sourceConfidenceInput: entry.source_confidence ?? entry.sourceConfidence ?? entry.confidence,
            rowIndex: context.rowIndex,
            rawKeys: Object.keys(entry).sort(),
            rowProvenance: isRecord(entry.provenance) ? entry.provenance : null,
          }),
        });
        continue;
      }
      const spec = canonicalizeMetricName(metricNameRaw);
      if (!spec) {
        ignoredMetrics.push({
          metricDate: resolveMetricDate(item.metric_date ?? item.metricDate ?? item.date ?? item.day ?? item.local_date),
          metricName: metricNameRaw,
          sourceName: context.sourceName,
          reason: "unsupported_metric",
          provenance: metricProvenance({
            base,
            metricSource: "metrics_array",
            metricInputName: metricNameRaw,
            metricName: "steps",
            sourceConfidenceInput: entry.source_confidence ?? entry.sourceConfidence ?? entry.confidence,
            rowIndex: context.rowIndex,
            rawKeys: Object.keys(entry).sort(),
            rowProvenance: isRecord(entry.provenance) ? entry.provenance : null,
          }),
        });
        continue;
      }
      metricEntries.push({
        source: "metrics_array",
        name: metricNameRaw,
        value: entry.metric_value ?? entry.metricValue ?? entry.value,
        unit: entry.unit ?? spec.unit,
        provenance: isRecord(entry.provenance) ? entry.provenance : null,
      });
    }
  }

  const freshnessHours = coerceFreshnessHours(item.freshness_hours ?? item.freshnessHours) ?? ingestFreshnessHours(context.exportedAt, context.ingestedAt);
  const sourceConfidence = coerceConfidence(item.source_confidence ?? item.sourceConfidence ?? item.confidence, null);
  const metricDate = resolveMetricDate(item.metric_date ?? item.metricDate ?? item.date ?? item.day ?? item.local_date);

  for (const entry of metricEntries) {
    if (!metricDate) {
      ignoredMetrics.push({
        metricDate: null,
        metricName: entry.name,
        sourceName: context.sourceName,
        reason: "missing_date",
        provenance: metricProvenance({
          base,
          metricSource: entry.source,
          metricInputName: entry.name,
          metricName: canonicalizeMetricName(entry.name)?.metricName ?? "steps",
          sourceConfidenceInput: sourceConfidence,
          rowIndex: context.rowIndex,
          rawKeys: directKeys.size > 0 ? [...directKeys].sort() : [],
          rowProvenance,
        }),
      });
      continue;
    }

    const normalized = canonicalizeMetricName(entry.name);
    const numericValue = parseMetricValue(entry.value);
    if (!normalized || numericValue == null) {
      ignoredMetrics.push({
        metricDate,
        metricName: entry.name,
        sourceName: context.sourceName,
        reason: numericValue == null ? "missing_value" : "unsupported_metric",
        provenance: metricProvenance({
          base,
          metricSource: entry.source,
          metricInputName: entry.name,
          metricName: normalized?.metricName ?? "steps",
          sourceConfidenceInput: sourceConfidence,
          rowIndex: context.rowIndex,
          rawKeys: directKeys.size > 0 ? [...directKeys].sort() : [],
          rowProvenance,
        }),
      });
      continue;
    }

    rows.push(
      toDailyRowInput({
        metricDate,
        metricName: normalized.metricName,
        sourceName: context.sourceName,
        metricValue: numericValue,
        unit: coerceString(entry.unit) ?? normalized.unit,
        freshnessHours,
        sourceConfidence,
        provenance: metricProvenance({
          base,
          metricSource: entry.source,
          metricInputName: entry.name,
          metricName: normalized.metricName,
          sourceConfidenceInput: sourceConfidence,
          rowIndex: context.rowIndex,
          rawKeys: directKeys.size > 0 ? [...directKeys].sort() : [],
          rowProvenance,
        }),
      }),
    );
  }

  return {
    rows,
    ignoredMetrics,
    summary: {
      sourceName: context.sourceName,
      exportedAt: context.exportedAt,
      ingestedAt: context.ingestedAt,
      rowCount: rows.length,
      ignoredCount: ignoredMetrics.length,
      payloadKind: context.payloadKind,
    },
  };
}

function sortRows(rows: HealthSourceDailyRowInput[]): HealthSourceDailyRowInput[] {
  return [...rows].sort((a, b) => {
    const date = a.metricDate.localeCompare(b.metricDate);
    if (date !== 0) return date;
    const source = String(a.sourceName).localeCompare(String(b.sourceName));
    if (source !== 0) return source;
    const metricOrder = METRIC_ORDER.indexOf(a.metricName) - METRIC_ORDER.indexOf(b.metricName);
    if (metricOrder !== 0) return metricOrder;
    return a.metricName.localeCompare(b.metricName);
  });
}

function sortIgnored(ignored: HealthSourceIgnoredMetric[]): HealthSourceIgnoredMetric[] {
  return [...ignored].sort((a, b) => {
    const dateA = a.metricDate ?? "9999-12-31";
    const dateB = b.metricDate ?? "9999-12-31";
    const date = dateA.localeCompare(dateB);
    if (date !== 0) return date;
    const source = String(a.sourceName).localeCompare(String(b.sourceName));
    if (source !== 0) return source;
    const metric = a.metricName.localeCompare(b.metricName);
    if (metric !== 0) return metric;
    return a.reason.localeCompare(b.reason);
  });
}

function buildIngestResult(
  payload: unknown,
  options: { ingestedAt?: string | null } = {},
): HealthSourceIngestResult {
  const normalizedPayload = isRecord(payload) ? payload : {};
  const sourceName = payloadSourceName(normalizedPayload);
  const sourceInput = coerceString(normalizedPayload.source_name ?? normalizedPayload.sourceName ?? normalizedPayload.source) ?? null;
  const sourceVersion = payloadSourceVersion(normalizedPayload);
  const exportedAt = payloadExportedAt(normalizedPayload);
  const ingestedAt = coerceString(options.ingestedAt) ?? new Date().toISOString();
  const kind = payloadKind(normalizedPayload);
  const baseContext = {
    payload: normalizedPayload,
    sourceName,
    sourceInput,
    sourceVersion,
    exportedAt,
    ingestedAt,
    payloadKind: kind,
  } as const;

  const rows: HealthSourceDailyRowInput[] = [];
  const ignoredMetrics: HealthSourceIgnoredMetric[] = [];

  const candidates: unknown[] = Array.isArray(normalizedPayload.rows)
    ? normalizedPayload.rows
    : Array.isArray(normalizedPayload.days)
      ? normalizedPayload.days
      : Array.isArray(normalizedPayload.entries)
        ? normalizedPayload.entries
        : [normalizedPayload];

  candidates.forEach((candidate, index) => {
    if (!isRecord(candidate)) return;

    const rowLooksNormalized =
      (candidate.metric_date != null || candidate.metricDate != null || candidate.date != null || candidate.day != null || candidate.local_date != null) &&
      (candidate.metric_name != null || candidate.metricName != null || candidate.name != null) &&
      (candidate.metric_value != null || candidate.metricValue != null || candidate.value != null);

    if (rowLooksNormalized) {
      const row = normalizedRowFromRecord(candidate, { ...baseContext, rowIndex: index, rowKind: "normalized_row" });
      if (row.row) rows.push(row.row);
      if (row.ignored) ignoredMetrics.push(row.ignored);
      return;
    }

    const expanded = expandDailyRecord(candidate, { ...baseContext, rowIndex: index });
    rows.push(...expanded.rows);
    ignoredMetrics.push(...expanded.ignoredMetrics);
  });

  const dedupedRows = new Map<string, HealthSourceDailyRowInput>();
  for (const row of rows) {
    dedupedRows.set(`${row.metricDate}|${row.metricName}|${row.sourceName}`, row);
  }

  return {
    rows: sortRows([...dedupedRows.values()]),
    ignoredMetrics: sortIgnored(ignoredMetrics),
    summary: {
      sourceName,
      exportedAt,
      ingestedAt,
      rowCount: dedupedRows.size,
      ignoredCount: ignoredMetrics.length,
      payloadKind: kind,
    },
  };
}

function buildHealthSourceSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS cortana_fitness_health_source_daily (
  metric_date DATE NOT NULL,
  metric_name TEXT NOT NULL,
  source_name TEXT NOT NULL,
  metric_value NUMERIC(12,3) NOT NULL,
  unit TEXT,
  freshness_hours NUMERIC(8,2) CHECK (freshness_hours IS NULL OR freshness_hours >= 0),
  source_confidence NUMERIC(4,3) CHECK (source_confidence IS NULL OR (source_confidence >= 0 AND source_confidence <= 1)),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (metric_date, metric_name, source_name)
);

CREATE INDEX IF NOT EXISTS idx_health_source_daily_metric_date ON cortana_fitness_health_source_daily(metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_health_source_daily_metric_name ON cortana_fitness_health_source_daily(metric_name);
CREATE INDEX IF NOT EXISTS idx_health_source_daily_source_name ON cortana_fitness_health_source_daily(source_name);
`;
}

function ensureHealthSourceSchema(): void {
  if (healthSourceSchemaEnsured) return;
  const result = runPsql(`
SELECT pg_advisory_lock(${HEALTH_SOURCE_SCHEMA_LOCK_KEY});
${buildHealthSourceSchemaSql()}
SELECT pg_advisory_unlock(${HEALTH_SOURCE_SCHEMA_LOCK_KEY});
`);
  if (result.status !== 0) {
    throw new Error((result.stderr || "failed to ensure health source schema").trim());
  }
  healthSourceSchemaEnsured = true;
}

function buildHealthSourceDailyUpsertSql(input: HealthSourceDailyRowInput): string {
  return `
INSERT INTO cortana_fitness_health_source_daily (
  metric_date, metric_name, source_name, metric_value, unit, freshness_hours, source_confidence, provenance
) VALUES (
  ${sqlText(input.metricDate)}::date,
  ${sqlText(input.metricName)},
  ${sqlText(input.sourceName)},
  ${sqlNum(input.metricValue)},
  ${sqlText(input.unit ?? null)},
  ${sqlNum(input.freshnessHours ?? null)},
  ${sqlNum(input.sourceConfidence ?? null)},
  ${sqlJson(input.provenance ?? null)}
)
ON CONFLICT (metric_date, metric_name, source_name) DO UPDATE
SET
  metric_value = COALESCE(EXCLUDED.metric_value, cortana_fitness_health_source_daily.metric_value),
  unit = COALESCE(EXCLUDED.unit, cortana_fitness_health_source_daily.unit),
  freshness_hours = COALESCE(EXCLUDED.freshness_hours, cortana_fitness_health_source_daily.freshness_hours),
  source_confidence = COALESCE(EXCLUDED.source_confidence, cortana_fitness_health_source_daily.source_confidence),
  provenance = COALESCE(cortana_fitness_health_source_daily.provenance, '{}'::jsonb) || COALESCE(EXCLUDED.provenance, '{}'::jsonb);
`;
}

function buildHealthSourceDailyBulkUpsertSql(rows: HealthSourceDailyRowInput[]): string {
  if (rows.length === 0) return "";
  return `BEGIN;\n${rows.map((row) => buildHealthSourceDailyUpsertSql(row)).join("\n")}\nCOMMIT;`;
}

function buildFetchHealthSourceRowsSql(startYmd: string, endYmd: string, metricName?: HealthSourceMetricName): string {
  const metricClause = metricName ? `AND metric_name = ${sqlText(metricName)}` : "";
  return `
SELECT COALESCE(json_agg(t ORDER BY t.metric_date, t.metric_name, t.source_name)::text, '[]') AS payload
FROM (
  SELECT *
  FROM cortana_fitness_health_source_daily
  WHERE metric_date BETWEEN ${sqlText(startYmd)}::date AND ${sqlText(endYmd)}::date
    ${metricClause}
  ORDER BY metric_date, metric_name, source_name
) t;
`;
}

function upsertHealthSourceDailyRows(rows: HealthSourceDailyRowInput[]): HealthSourceUpsertResult {
  if (rows.length === 0) {
    return { ok: true, rowsWritten: 0 };
  }
  ensureHealthSourceSchema();
  const result = runPsql(buildHealthSourceDailyBulkUpsertSql(rows));
  if (result.status !== 0) {
    return {
      ok: false,
      rowsWritten: 0,
      error: (result.stderr || "failed to upsert health source rows").trim(),
    };
  }
  return { ok: true, rowsWritten: rows.length };
}

export function normalizeHealthSourcePayload(
  payload: unknown,
  options: { ingestedAt?: string | null } = {},
): HealthSourceIngestResult {
  return buildIngestResult(payload, options);
}

export function buildHealthSourceDailySchemaSql(): string {
  return buildHealthSourceSchemaSql();
}

export function buildHealthSourceDailyUpsertStatement(input: HealthSourceDailyRowInput): string {
  return buildHealthSourceDailyUpsertSql(input);
}

export function buildHealthSourceDailyBulkUpsertStatement(rows: HealthSourceDailyRowInput[]): string {
  return buildHealthSourceDailyBulkUpsertSql(rows);
}

export function buildFetchHealthSourceRowsStatement(startYmd: string, endYmd: string, metricName?: HealthSourceMetricName): string {
  return buildFetchHealthSourceRowsSql(startYmd, endYmd, metricName);
}

export function persistHealthSourceDailyRows(rows: HealthSourceDailyRowInput[]): HealthSourceUpsertResult {
  return upsertHealthSourceDailyRows(rows);
}

export function fetchHealthSourceRows(startYmd: string, endYmd: string, metricName?: HealthSourceMetricName): HealthSourceDailyRow[] {
  ensureHealthSourceSchema();
  const result = runPsql(buildFetchHealthSourceRowsSql(startYmd, endYmd, metricName));
  if (result.status !== 0) return [];
  return parseJsonValue<HealthSourceDailyRow[]>(String(result.stdout ?? ""), []);
}

export function ingestHealthSourcePayload(
  payload: unknown,
  options: { ingestedAt?: string | null; persist?: boolean } = {},
): HealthSourceIngestResult & { writeResult: HealthSourceUpsertResult | null } {
  const result = normalizeHealthSourcePayload(payload, options);
  if (options.persist === false) {
    return { ...result, writeResult: null };
  }
  const writeResult = persistHealthSourceDailyRows(result.rows);
  if (!writeResult.ok) {
    throw new Error(writeResult.error || "failed to persist health source rows");
  }
  return { ...result, writeResult };
}
