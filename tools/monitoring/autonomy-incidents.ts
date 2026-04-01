import { runPsql } from "../lib/db.js";

export type IncidentSeverity = "info" | "warning" | "error";
export type IncidentState = "open" | "resolved";
export type IncidentRemediationStatus = "detected" | "escalate" | "skipped" | "remediated" | "verified" | "resolved";

export type IncidentUpsertInput = {
  incidentKey: string;
  incidentType: string;
  system: string;
  source: string;
  severity: IncidentSeverity;
  summary: string;
  detail?: string;
  metadata?: Record<string, unknown>;
  remediationStatus?: IncidentRemediationStatus;
};

export type OpenIncidentSummary = {
  open: number;
  recurring: number;
  labels: string[];
};

type IncidentRow = {
  state: string;
  severity: string;
  summary: string;
  last_detail: string;
  remediation_status: string;
  occurrence_count: number;
};

let schemaEnsured = false;

function sqlEscape(value: string): string {
  return String(value ?? "").replaceAll("'", "''");
}

function jsonSql(value: Record<string, unknown> | undefined): string {
  return `'${sqlEscape(JSON.stringify(value ?? {}))}'::jsonb`;
}

function run(sql: string) {
  return runPsql(sql);
}

export function ensureAutonomyIncidentSchema(): void {
  if (schemaEnsured) return;
  const sql = `
CREATE TABLE IF NOT EXISTS cortana_autonomy_incidents (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  incident_type TEXT NOT NULL,
  source TEXT,
  auto_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  escalated_to_human BOOLEAN NOT NULL DEFAULT FALSE,
  resolution_time_sec NUMERIC(10,2),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS incident_key TEXT;
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS system TEXT;
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'warning';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'open';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS remediation_status TEXT NOT NULL DEFAULT 'detected';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS last_detail TEXT NOT NULL DEFAULT '';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS verification TEXT NOT NULL DEFAULT '';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT '';
ALTER TABLE cortana_autonomy_incidents ADD COLUMN IF NOT EXISTS occurrence_count INTEGER NOT NULL DEFAULT 0;
UPDATE cortana_autonomy_incidents
SET incident_key = CONCAT('legacy:', id)
WHERE incident_key IS NULL OR incident_key = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_cortana_autonomy_incidents_incident_key
  ON cortana_autonomy_incidents (incident_key);
CREATE INDEX IF NOT EXISTS idx_cortana_autonomy_incidents_state_seen
  ON cortana_autonomy_incidents (state, last_seen_at DESC);
`;
  const res = run(sql);
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || "failed to ensure autonomy incident schema").trim());
  }
  schemaEnsured = true;
}

function selectIncident(incidentKey: string): IncidentRow | null {
  ensureAutonomyIncidentSchema();
  const res = run(`
SELECT json_build_object(
  'state', state,
  'severity', severity,
  'summary', summary,
  'last_detail', last_detail,
  'remediation_status', remediation_status,
  'occurrence_count', occurrence_count
)::text
FROM cortana_autonomy_incidents
WHERE incident_key = '${sqlEscape(incidentKey)}'
LIMIT 1;
`);
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || "failed to select autonomy incident").trim());
  }
  const raw = String(res.stdout ?? "").trim();
  if (!raw) return null;
  return JSON.parse(raw) as IncidentRow;
}

export function upsertOpenIncident(input: IncidentUpsertInput): "created" | "updated" | "unchanged" {
  ensureAutonomyIncidentSchema();
  const remediationStatus = input.remediationStatus ?? "detected";
  const existing = selectIncident(input.incidentKey);
  const nextDetail = String(input.detail ?? "");
  const nextSummary = String(input.summary ?? "");
  const nextSeverity = String(input.severity);
  const changed = !existing || existing.state !== "open" || existing.severity !== nextSeverity || existing.summary !== nextSummary || existing.last_detail !== nextDetail || existing.remediation_status !== remediationStatus;

  const sql = `
INSERT INTO cortana_autonomy_incidents (
  incident_key, incident_type, system, source, severity, state,
  first_seen_at, last_seen_at, resolved_at, remediation_status,
  summary, last_detail, occurrence_count, auto_resolved, escalated_to_human, metadata
)
VALUES (
  '${sqlEscape(input.incidentKey)}',
  '${sqlEscape(input.incidentType)}',
  '${sqlEscape(input.system)}',
  '${sqlEscape(input.source)}',
  '${sqlEscape(nextSeverity)}',
  'open',
  NOW(),
  NOW(),
  NULL,
  '${sqlEscape(remediationStatus)}',
  '${sqlEscape(nextSummary)}',
  '${sqlEscape(nextDetail)}',
  1,
  FALSE,
  ${remediationStatus === "escalate" ? "TRUE" : "FALSE"},
  ${jsonSql(input.metadata)}
)
ON CONFLICT (incident_key) DO UPDATE SET
  timestamp = NOW(),
  incident_type = EXCLUDED.incident_type,
  system = EXCLUDED.system,
  source = EXCLUDED.source,
  severity = EXCLUDED.severity,
  state = 'open',
  last_seen_at = NOW(),
  resolved_at = NULL,
  remediation_status = EXCLUDED.remediation_status,
  summary = EXCLUDED.summary,
  last_detail = EXCLUDED.last_detail,
  occurrence_count = cortana_autonomy_incidents.occurrence_count + 1,
  auto_resolved = FALSE,
  escalated_to_human = EXCLUDED.escalated_to_human,
  metadata = EXCLUDED.metadata;
`;
  const res = run(sql);
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || "failed to upsert autonomy incident").trim());
  }
  if (!existing) return "created";
  return changed ? "updated" : "unchanged";
}

export function resolveIncident(
  incidentKey: string,
  resolution: {
    source: string;
    summary: string;
    detail?: string;
    remediationStatus?: IncidentRemediationStatus;
    autoResolved?: boolean;
    metadata?: Record<string, unknown>;
  },
): "resolved" | "already_resolved" | "missing" {
  ensureAutonomyIncidentSchema();
  const existing = selectIncident(incidentKey);
  if (!existing) return "missing";
  const remediationStatus = resolution.remediationStatus ?? "resolved";
  if (existing.state === "resolved" && existing.remediation_status === remediationStatus) {
    return "already_resolved";
  }
  const res = run(`
UPDATE cortana_autonomy_incidents
SET
  timestamp = NOW(),
  source = '${sqlEscape(resolution.source)}',
  state = 'resolved',
  last_seen_at = NOW(),
  resolved_at = NOW(),
  remediation_status = '${sqlEscape(remediationStatus)}',
  summary = '${sqlEscape(resolution.summary)}',
  last_detail = '${sqlEscape(String(resolution.detail ?? ""))}',
  auto_resolved = ${resolution.autoResolved ? "TRUE" : "FALSE"},
  metadata = ${jsonSql(resolution.metadata)}
WHERE incident_key = '${sqlEscape(incidentKey)}';
`);
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || "failed to resolve autonomy incident").trim());
  }
  return "resolved";
}

export function collectOpenIncidentSummary(): OpenIncidentSummary {
  ensureAutonomyIncidentSchema();
  const res = run(`
SELECT json_build_object(
  'open', COUNT(*)::int,
  'recurring', COUNT(*) FILTER (WHERE occurrence_count > 1)::int,
  'labels', COALESCE(
    json_agg(CONCAT(system, ':', incident_type) ORDER BY last_seen_at DESC)
      FILTER (WHERE state = 'open'),
    '[]'::json
  )
)::text
FROM cortana_autonomy_incidents
WHERE state = 'open';
`);
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || "failed to collect autonomy incidents").trim());
  }
  const raw = String(res.stdout ?? "").trim();
  if (!raw) return { open: 0, recurring: 0, labels: [] };
  const parsed = JSON.parse(raw) as { open?: number; recurring?: number; labels?: string[] | null };
  return {
    open: Number(parsed.open ?? 0),
    recurring: Number(parsed.recurring ?? 0),
    labels: Array.isArray(parsed.labels) ? parsed.labels.slice(0, 5).map(String) : [],
  };
}
