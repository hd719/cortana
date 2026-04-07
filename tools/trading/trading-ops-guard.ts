import { spawnSync } from "node:child_process";
import { runPsql, withPostgresPath } from "../lib/db";
import { resolveRepoPath } from "../lib/paths";

const SOURCE = "trading-ops-guard";
const TELEGRAM_GUARD = resolveRepoPath("tools", "notifications", "telegram-delivery-guard.sh");
const ALERT_TARGET = process.env.TRADING_OPS_GUARD_TARGET || "8171372724";

type IncidentSeverity = "warning" | "error" | "critical";
type SyncMode = "skipped" | "failed";

export function reportTradingRunSyncIncident(input: {
  runId: string;
  stage: string;
  mode: SyncMode;
  reason: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = input.env ?? process.env;
  const category = classifySyncCategory(input.reason, input.mode);
  const message = buildSyncIncidentMessage(input.runId, input.stage, input.mode, input.reason);
  const severity = input.mode === "failed" ? "critical" : "error";

  logIncident({
    severity,
    message,
    metadata: {
      run_id: input.runId,
      stage: input.stage,
      mode: input.mode,
      category,
      reason: input.reason,
    },
    env,
  });

  sendIncidentAlert({
    dedupeKey: `trading_ops_sync:${category}`,
    message: [
      "Trading Ops DB sync degraded.",
      `Run ${input.runId} hit ${input.mode} at stage ${input.stage}.`,
      input.reason,
    ].join("\n"),
    severity: input.mode === "failed" ? "high" : "critical",
    env,
  });
}

export function reportMissionControlIncident(input: {
  kind: "restart_failed" | "smoke_failed";
  message: string;
  detail: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = input.env ?? process.env;
  const severity: IncidentSeverity = input.kind === "restart_failed" ? "critical" : "error";

  logIncident({
    severity,
    message: `${input.message} ${input.detail}`.trim(),
    metadata: {
      kind: input.kind,
      detail: input.detail,
    },
    env,
  });

  sendIncidentAlert({
    dedupeKey: `mission_control:${input.kind}`,
    message: `${input.message}\n${input.detail}`.trim(),
    severity: input.kind === "restart_failed" ? "critical" : "high",
    env,
  });
}

function buildSyncIncidentMessage(runId: string, stage: string, mode: SyncMode, reason: string): string {
  return `Trading run sync ${mode}: run_id=${runId} stage=${stage} reason=${reason}`;
}

function classifySyncCategory(reason: string, mode: SyncMode): string {
  const lower = reason.toLowerCase();
  if (lower.includes("mission_control_database_url")) return "mission_control_db_missing";
  if (lower.includes("summary artifact missing") || lower.includes("invalid")) return "artifact_invalid";
  if (mode === "skipped") return "sync_skipped";
  return "sync_failed";
}

function logIncident(input: {
  severity: IncidentSeverity;
  message: string;
  metadata: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
}): void {
  const sql = `
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES (
      'trading_ops_guardrail',
      '${sqlEscape(SOURCE)}',
      '${sqlEscape(input.severity)}',
      '${sqlEscape(input.message)}',
      '${sqlEscape(JSON.stringify(input.metadata))}'::jsonb
    );
  `;

  try {
    runPsql(sql, {
      db: input.env.CORTANA_DB ?? "cortana",
      args: ["-q", "-X", "-v", "ON_ERROR_STOP=1"],
      env: withPostgresPath(input.env),
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Logging should never block the calling trading path.
  }
}

function sendIncidentAlert(input: {
  dedupeKey: string;
  message: string;
  severity: "critical" | "high";
  env: NodeJS.ProcessEnv;
}): void {
  if (alertsDisabled(input.env)) return;

  spawnSync(
    TELEGRAM_GUARD,
    [
      input.message,
      ALERT_TARGET,
      "",
      "trading_ops_guardrail",
      input.dedupeKey,
      input.severity,
      "monitor",
      "Trading Ops",
      "now",
      SOURCE,
    ],
    {
      cwd: resolveRepoPath(),
      encoding: "utf8",
      env: input.env,
      stdio: "ignore",
    },
  );
}

function alertsDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = String(env.TRADING_OPS_GUARD_DISABLE_ALERTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}
