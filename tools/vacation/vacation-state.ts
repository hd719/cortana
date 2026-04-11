import fs from "node:fs";
import path from "node:path";
import { runPsql } from "../lib/db.js";
import { resolveRuntimeStatePath } from "../lib/paths.js";
import type {
  VacationActionRow,
  VacationCheckResultRow,
  VacationDisableReason,
  VacationMirrorState,
  VacationRunRow,
  VacationWindowRow,
} from "./types.js";

export const VACATION_RUNTIME_MIRROR_PATH = resolveRuntimeStatePath("state", "vacation-mode.json");

type RuntimeCronJob = {
  id?: string;
  name?: string;
  enabled?: boolean;
  updatedAtMs?: number;
  [key: string]: unknown;
};

type RuntimeCronConfig = {
  jobs?: RuntimeCronJob[];
  [key: string]: unknown;
};

function sqlEscape(value: string): string {
  return String(value ?? "").replaceAll("'", "''");
}

function jsonSql(value: unknown): string {
  return `'${sqlEscape(JSON.stringify(value ?? {}))}'::jsonb`;
}

function queryText(sql: string): string {
  const result = runPsql(sql);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "vacation state query failed").trim());
  }
  return String(result.stdout ?? "").trim();
}

function queryOneJson<T>(sql: string): T | null {
  const raw = queryText(sql);
  if (!raw) return null;
  return JSON.parse(raw) as T;
}

function queryManyJson<T>(sql: string): T[] {
  const raw = queryText(sql);
  if (!raw) return [];
  return JSON.parse(raw) as T[];
}

function readRuntimeCronConfig(runtimeFile = resolveRuntimeStatePath("cron", "jobs.json")): RuntimeCronConfig | null {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile, "utf8")) as RuntimeCronConfig;
  } catch {
    return null;
  }
}

function writeRuntimeCronConfig(config: RuntimeCronConfig, runtimeFile = resolveRuntimeStatePath("cron", "jobs.json")): void {
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
  fs.writeFileSync(runtimeFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function readVacationMirror(mirrorPath = VACATION_RUNTIME_MIRROR_PATH): VacationMirrorState | null {
  try {
    return JSON.parse(fs.readFileSync(mirrorPath, "utf8")) as VacationMirrorState;
  } catch {
    return null;
  }
}

export function writeVacationMirror(mirror: VacationMirrorState, mirrorPath = VACATION_RUNTIME_MIRROR_PATH): void {
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  fs.writeFileSync(mirrorPath, `${JSON.stringify(mirror, null, 2)}\n`, "utf8");
}

export function archiveVacationMirror(mirrorPath = VACATION_RUNTIME_MIRROR_PATH): string | null {
  if (!fs.existsSync(mirrorPath)) return null;
  const archivedPath = `${mirrorPath}.${new Date().toISOString().replaceAll(":", "-")}.bak`;
  fs.renameSync(mirrorPath, archivedPath);
  return archivedPath;
}

export function clearVacationMirror(mirrorPath = VACATION_RUNTIME_MIRROR_PATH): void {
  try {
    fs.rmSync(mirrorPath, { force: true });
  } catch {
    // best-effort clear
  }
}

export function buildVacationMirror(window: VacationWindowRow, latestReadinessRunId: number | null): VacationMirrorState {
  const stateSnapshot = window.state_snapshot ?? {};
  const pausedJobIds = Array.isArray(stateSnapshot.paused_job_ids)
    ? stateSnapshot.paused_job_ids.map((value) => String(value))
    : [];
  return {
    enabled: window.status === "active",
    windowId: window.id,
    status: window.status,
    timezone: window.timezone,
    startAt: window.start_at,
    endAt: window.end_at,
    pausedJobIds,
    latestReadinessRunId,
    lastTransitionAt: window.disabled_at ?? window.enabled_at ?? window.prep_completed_at ?? window.updated_at ?? null,
  };
}

export function reconcileVacationMirror(mirrorPath = VACATION_RUNTIME_MIRROR_PATH): VacationMirrorState | null {
  const activeWindow = getActiveVacationWindow();
  if (!activeWindow) {
    clearVacationMirror(mirrorPath);
    return null;
  }
  const latestReadiness = getLatestReadinessRun(activeWindow.id);
  const mirror = buildVacationMirror(activeWindow, latestReadiness?.id ?? null);
  writeVacationMirror(mirror, mirrorPath);
  return mirror;
}

function vacationWindowSelect(whereSql: string): string {
  return `
SELECT json_build_object(
  'id', id,
  'label', label,
  'status', status,
  'timezone', timezone,
  'start_at', start_at,
  'end_at', end_at,
  'prep_recommended_at', prep_recommended_at,
  'prep_started_at', prep_started_at,
  'prep_completed_at', prep_completed_at,
  'enabled_at', enabled_at,
  'disabled_at', disabled_at,
  'disable_reason', disable_reason,
  'trigger_source', trigger_source,
  'created_by', created_by,
  'config_snapshot', config_snapshot,
  'state_snapshot', state_snapshot,
  'created_at', created_at,
  'updated_at', updated_at
)::text
FROM cortana_vacation_windows
${whereSql}
LIMIT 1;
`;
}

function vacationRunSelect(whereSql: string): string {
  return `
SELECT json_build_object(
  'id', id,
  'vacation_window_id', vacation_window_id,
  'run_type', run_type,
  'trigger_source', trigger_source,
  'dry_run', dry_run,
  'readiness_outcome', readiness_outcome,
  'summary_status', summary_status,
  'summary_payload', summary_payload,
  'summary_text', summary_text,
  'started_at', started_at,
  'completed_at', completed_at,
  'state', state
)::text
FROM cortana_vacation_runs
${whereSql}
LIMIT 1;
`;
}

export function getVacationWindow(windowId: number): VacationWindowRow | null {
  return queryOneJson<VacationWindowRow>(vacationWindowSelect(`WHERE id = ${Number(windowId)}`));
}

export function getActiveVacationWindow(): VacationWindowRow | null {
  return queryOneJson<VacationWindowRow>(vacationWindowSelect(`WHERE status = 'active' ORDER BY start_at DESC`));
}

export function createVacationWindow(input: {
  label: string;
  status: VacationWindowRow["status"];
  timezone: string;
  startAt: string;
  endAt: string;
  prepRecommendedAt?: string | null;
  triggerSource: VacationWindowRow["trigger_source"];
  createdBy?: string;
  configSnapshot?: Record<string, unknown>;
  stateSnapshot?: Record<string, unknown>;
}): VacationWindowRow {
  return queryOneJson<VacationWindowRow>(`
INSERT INTO cortana_vacation_windows (
  label, status, timezone, start_at, end_at, prep_recommended_at,
  trigger_source, created_by, config_snapshot, state_snapshot
)
VALUES (
  '${sqlEscape(input.label)}',
  '${sqlEscape(input.status)}',
  '${sqlEscape(input.timezone)}',
  TIMESTAMPTZ '${sqlEscape(input.startAt)}',
  TIMESTAMPTZ '${sqlEscape(input.endAt)}',
  ${input.prepRecommendedAt ? `TIMESTAMPTZ '${sqlEscape(input.prepRecommendedAt)}'` : "NULL"},
  '${sqlEscape(input.triggerSource)}',
  '${sqlEscape(input.createdBy ?? "hamel")}',
  ${jsonSql(input.configSnapshot ?? {})},
  ${jsonSql(input.stateSnapshot ?? {})}
)
RETURNING json_build_object(
  'id', id,
  'label', label,
  'status', status,
  'timezone', timezone,
  'start_at', start_at,
  'end_at', end_at,
  'prep_recommended_at', prep_recommended_at,
  'prep_started_at', prep_started_at,
  'prep_completed_at', prep_completed_at,
  'enabled_at', enabled_at,
  'disabled_at', disabled_at,
  'disable_reason', disable_reason,
  'trigger_source', trigger_source,
  'created_by', created_by,
  'config_snapshot', config_snapshot,
  'state_snapshot', state_snapshot,
  'created_at', created_at,
  'updated_at', updated_at
)::text;
`) as VacationWindowRow;
}

export function updateVacationWindow(windowId: number, patch: {
  status?: VacationWindowRow["status"];
  prepStartedAt?: string | null;
  prepCompletedAt?: string | null;
  enabledAt?: string | null;
  disabledAt?: string | null;
  disableReason?: VacationDisableReason | null;
  stateSnapshot?: Record<string, unknown>;
}): VacationWindowRow {
  const assignments: string[] = ["updated_at = NOW()"];
  if (patch.status) assignments.push(`status = '${sqlEscape(patch.status)}'`);
  if ("prepStartedAt" in patch) assignments.push(`prep_started_at = ${patch.prepStartedAt ? `TIMESTAMPTZ '${sqlEscape(patch.prepStartedAt)}'` : "NULL"}`);
  if ("prepCompletedAt" in patch) assignments.push(`prep_completed_at = ${patch.prepCompletedAt ? `TIMESTAMPTZ '${sqlEscape(patch.prepCompletedAt)}'` : "NULL"}`);
  if ("enabledAt" in patch) assignments.push(`enabled_at = ${patch.enabledAt ? `TIMESTAMPTZ '${sqlEscape(patch.enabledAt)}'` : "NULL"}`);
  if ("disabledAt" in patch) assignments.push(`disabled_at = ${patch.disabledAt ? `TIMESTAMPTZ '${sqlEscape(patch.disabledAt)}'` : "NULL"}`);
  if ("disableReason" in patch) assignments.push(`disable_reason = ${patch.disableReason ? `'${sqlEscape(patch.disableReason)}'` : "NULL"}`);
  if ("stateSnapshot" in patch) assignments.push(`state_snapshot = ${jsonSql(patch.stateSnapshot ?? {})}`);

  return queryOneJson<VacationWindowRow>(`
UPDATE cortana_vacation_windows
SET ${assignments.join(", ")}
WHERE id = ${Number(windowId)}
RETURNING json_build_object(
  'id', id,
  'label', label,
  'status', status,
  'timezone', timezone,
  'start_at', start_at,
  'end_at', end_at,
  'prep_recommended_at', prep_recommended_at,
  'prep_started_at', prep_started_at,
  'prep_completed_at', prep_completed_at,
  'enabled_at', enabled_at,
  'disabled_at', disabled_at,
  'disable_reason', disable_reason,
  'trigger_source', trigger_source,
  'created_by', created_by,
  'config_snapshot', config_snapshot,
  'state_snapshot', state_snapshot,
  'created_at', created_at,
  'updated_at', updated_at
)::text;
`) as VacationWindowRow;
}

export function startVacationRun(input: {
  vacationWindowId?: number | null;
  runType: VacationRunRow["run_type"];
  triggerSource: VacationRunRow["trigger_source"];
  dryRun?: boolean;
}): VacationRunRow {
  return queryOneJson<VacationRunRow>(`
INSERT INTO cortana_vacation_runs (vacation_window_id, run_type, trigger_source, dry_run)
VALUES (
  ${input.vacationWindowId == null ? "NULL" : Number(input.vacationWindowId)},
  '${sqlEscape(input.runType)}',
  '${sqlEscape(input.triggerSource)}',
  ${input.dryRun ? "TRUE" : "FALSE"}
)
RETURNING json_build_object(
  'id', id,
  'vacation_window_id', vacation_window_id,
  'run_type', run_type,
  'trigger_source', trigger_source,
  'dry_run', dry_run,
  'readiness_outcome', readiness_outcome,
  'summary_status', summary_status,
  'summary_payload', summary_payload,
  'summary_text', summary_text,
  'started_at', started_at,
  'completed_at', completed_at,
  'state', state
)::text;
`) as VacationRunRow;
}

export function finishVacationRun(runId: number, patch: {
  state: VacationRunRow["state"];
  readinessOutcome?: VacationRunRow["readiness_outcome"];
  summaryStatus?: VacationRunRow["summary_status"];
  summaryPayload?: Record<string, unknown>;
  summaryText?: string;
}): VacationRunRow {
  const assignments = [
    `state = '${sqlEscape(patch.state)}'`,
    "completed_at = NOW()",
  ];
  if ("readinessOutcome" in patch) assignments.push(`readiness_outcome = ${patch.readinessOutcome ? `'${sqlEscape(patch.readinessOutcome)}'` : "NULL"}`);
  if ("summaryStatus" in patch) assignments.push(`summary_status = ${patch.summaryStatus ? `'${sqlEscape(patch.summaryStatus)}'` : "NULL"}`);
  if ("summaryPayload" in patch) assignments.push(`summary_payload = ${jsonSql(patch.summaryPayload ?? {})}`);
  if ("summaryText" in patch) assignments.push(`summary_text = '${sqlEscape(patch.summaryText ?? "")}'`);

  return queryOneJson<VacationRunRow>(`
UPDATE cortana_vacation_runs
SET ${assignments.join(", ")}
WHERE id = ${Number(runId)}
RETURNING json_build_object(
  'id', id,
  'vacation_window_id', vacation_window_id,
  'run_type', run_type,
  'trigger_source', trigger_source,
  'dry_run', dry_run,
  'readiness_outcome', readiness_outcome,
  'summary_status', summary_status,
  'summary_payload', summary_payload,
  'summary_text', summary_text,
  'started_at', started_at,
  'completed_at', completed_at,
  'state', state
)::text;
`) as VacationRunRow;
}

export function getLatestReadinessRun(windowId?: number | null): VacationRunRow | null {
  const clauses = [`run_type = 'readiness'`];
  if (windowId != null) clauses.push(`vacation_window_id = ${Number(windowId)}`);
  return queryOneJson<VacationRunRow>(vacationRunSelect(`WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC`));
}

export function recordVacationCheckResults(runId: number, rows: VacationCheckResultRow[]): void {
  if (!rows.length) return;
  const values = rows.map((row) => `(
    ${Number(runId)},
    '${sqlEscape(row.system_key)}',
    ${Number(row.tier)},
    '${sqlEscape(row.status)}',
    TIMESTAMPTZ '${sqlEscape(row.observed_at)}',
    ${row.freshness_at ? `TIMESTAMPTZ '${sqlEscape(row.freshness_at)}'` : "NULL"},
    ${row.remediation_attempted ? "TRUE" : "FALSE"},
    ${row.remediation_succeeded ? "TRUE" : "FALSE"},
    ${row.autonomy_incident_id == null ? "NULL" : Number(row.autonomy_incident_id)},
    ${row.incident_key ? `'${sqlEscape(row.incident_key)}'` : "NULL"},
    ${jsonSql(row.detail)}
  )`);
  void queryText(`
INSERT INTO cortana_vacation_check_results (
  run_id, system_key, tier, status, observed_at, freshness_at,
  remediation_attempted, remediation_succeeded, autonomy_incident_id, incident_key, detail
)
VALUES ${values.join(", ")};
`);
}

export function recordVacationActions(rows: VacationActionRow[]): void {
  if (!rows.length) return;
  const values = rows.map((row) => `(
    ${Number(row.vacation_window_id)},
    ${row.run_id == null ? "NULL" : Number(row.run_id)},
    ${row.autonomy_incident_id == null ? "NULL" : Number(row.autonomy_incident_id)},
    ${row.incident_key ? `'${sqlEscape(row.incident_key)}'` : "NULL"},
    '${sqlEscape(row.system_key)}',
    ${Number(row.step_order)},
    '${sqlEscape(row.action_kind)}',
    '${sqlEscape(row.action_status)}',
    ${row.verification_status ? `'${sqlEscape(row.verification_status)}'` : "NULL"},
    ${row.started_at ? `TIMESTAMPTZ '${sqlEscape(row.started_at)}'` : "NOW()"},
    ${row.completed_at ? `TIMESTAMPTZ '${sqlEscape(row.completed_at)}'` : "NULL"},
    ${jsonSql(row.detail)}
  )`);
  void queryText(`
INSERT INTO cortana_vacation_actions (
  vacation_window_id, run_id, autonomy_incident_id, incident_key,
  system_key, step_order, action_kind, action_status, verification_status,
  started_at, completed_at, detail
)
VALUES ${values.join(", ")};
`);
}

export function listVacationIncidents(windowId: number, statusFilter?: string[]): VacationIncidentRow[] {
  const whereParts = [`vacation_window_id = ${Number(windowId)}`];
  if (statusFilter?.length) {
    whereParts.push(`status IN (${statusFilter.map((value) => `'${sqlEscape(value)}'`).join(", ")})`);
  }
  return queryManyJson<VacationIncidentRow>(`
SELECT COALESCE(json_agg(json_build_object(
  'id', id,
  'vacation_window_id', vacation_window_id,
  'run_id', run_id,
  'latest_check_result_id', latest_check_result_id,
  'latest_action_id', latest_action_id,
  'system_key', system_key,
  'tier', tier,
  'status', status,
  'human_required', human_required,
  'first_observed_at', first_observed_at,
  'last_observed_at', last_observed_at,
  'resolved_at', resolved_at,
  'resolution_reason', resolution_reason,
  'symptom', symptom,
  'detail', detail,
  'created_at', created_at,
  'updated_at', updated_at
) ORDER BY updated_at DESC), '[]'::json)::text
FROM cortana_vacation_incidents
WHERE ${whereParts.join(" AND ")};
`);
}

export function upsertVacationIncident(input: {
  vacationWindowId: number;
  runId?: number | null;
  latestCheckResultId?: number | null;
  latestActionId?: number | null;
  systemKey: string;
  tier: number;
  status: string;
  humanRequired: boolean;
  observedAt: string;
  symptom?: string;
  detail?: Record<string, unknown>;
  resolutionReason?: string | null;
}): void {
  const resolved = input.status === "resolved";
  const assignments = [
    `run_id = ${input.runId == null ? "NULL" : Number(input.runId)}`,
    `latest_check_result_id = ${input.latestCheckResultId == null ? "NULL" : Number(input.latestCheckResultId)}`,
    `latest_action_id = ${input.latestActionId == null ? "latest_action_id" : Number(input.latestActionId)}`,
    `tier = ${Number(input.tier)}`,
    `status = '${sqlEscape(input.status)}'`,
    `human_required = ${input.humanRequired ? "TRUE" : "FALSE"}`,
    `last_observed_at = TIMESTAMPTZ '${sqlEscape(input.observedAt)}'`,
    `resolved_at = ${resolved ? `TIMESTAMPTZ '${sqlEscape(input.observedAt)}'` : "NULL"}`,
    `resolution_reason = ${input.resolutionReason ? `'${sqlEscape(input.resolutionReason)}'` : "NULL"}`,
    `symptom = ${input.symptom ? `'${sqlEscape(input.symptom)}'` : "NULL"}`,
    `detail = ${jsonSql(input.detail ?? {})}`,
    "updated_at = NOW()",
  ];

  if (resolved) {
    void queryText(`
WITH existing AS (
  SELECT id
  FROM cortana_vacation_incidents
  WHERE vacation_window_id = ${Number(input.vacationWindowId)}
    AND system_key = '${sqlEscape(input.systemKey)}'
  ORDER BY CASE WHEN status IN ('open', 'degraded', 'human_required') THEN 0 ELSE 1 END, updated_at DESC
  LIMIT 1
)
UPDATE cortana_vacation_incidents
SET ${assignments.join(", ")}
WHERE id = (SELECT id FROM existing);
`);
    return;
  }

  void queryText(`
WITH existing AS (
  SELECT id
  FROM cortana_vacation_incidents
  WHERE vacation_window_id = ${Number(input.vacationWindowId)}
    AND system_key = '${sqlEscape(input.systemKey)}'
    AND status IN ('open', 'degraded', 'human_required')
  LIMIT 1
),
updated AS (
  UPDATE cortana_vacation_incidents
  SET ${assignments.join(", ")}
  WHERE id = (SELECT id FROM existing)
  RETURNING id
)
INSERT INTO cortana_vacation_incidents (
  vacation_window_id, run_id, latest_check_result_id, latest_action_id,
  system_key, tier, status, human_required, first_observed_at, last_observed_at,
  resolved_at, resolution_reason, symptom, detail
)
SELECT
  ${Number(input.vacationWindowId)},
  ${input.runId == null ? "NULL" : Number(input.runId)},
  ${input.latestCheckResultId == null ? "NULL" : Number(input.latestCheckResultId)},
  ${input.latestActionId == null ? "NULL" : Number(input.latestActionId)},
  '${sqlEscape(input.systemKey)}',
  ${Number(input.tier)},
  '${sqlEscape(input.status)}',
  ${input.humanRequired ? "TRUE" : "FALSE"},
  TIMESTAMPTZ '${sqlEscape(input.observedAt)}',
  TIMESTAMPTZ '${sqlEscape(input.observedAt)}',
  NULL,
  ${input.resolutionReason ? `'${sqlEscape(input.resolutionReason)}'` : "NULL"},
  ${input.symptom ? `'${sqlEscape(input.symptom)}'` : "NULL"},
  ${jsonSql(input.detail ?? {})}
WHERE NOT EXISTS (SELECT 1 FROM updated);
`);
}

export function setRuntimeCronJobsEnabled(jobIds: string[], enabled: boolean, runtimeFile = resolveRuntimeStatePath("cron", "jobs.json")): string[] {
  const doc = readRuntimeCronConfig(runtimeFile);
  if (!doc || !Array.isArray(doc.jobs)) return [];
  const changed: string[] = [];
  const now = Date.now();
  for (const job of doc.jobs) {
    const id = String(job.id ?? "");
    if (!id || !jobIds.includes(id)) continue;
    if (Boolean(job.enabled) === enabled) continue;
    job.enabled = enabled;
    job.updatedAtMs = now;
    changed.push(id);
  }
  if (changed.length) writeRuntimeCronConfig(doc, runtimeFile);
  return changed;
}
