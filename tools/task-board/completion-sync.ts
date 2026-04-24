#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { classifyTerminalOutcome, type SessionRow } from "./lifecycle.js";
import { checkIdempotency, generateOperationId, logIdempotency } from "../lib/idempotency.js";
import { runPsql, withPostgresPath } from "../lib/db.js";
import { repoRoot } from "../lib/paths.js";

export { classifyTerminalOutcome } from "./lifecycle.js";

type Json = Record<string, any>;

type SessionsPayload = {
  sessions?: SessionRow[];
};

type CompletionResult = {
  task_id: number;
  label: string;
  session_key: string;
  run_id: string;
  status: string;
  mapped_outcome: "completed" | "failed";
};

type CompletionSyncReport = {
  ok: true;
  skipped?: true;
  reason?: string;
  synced_count: number;
  synced: CompletionResult[];
};

const SOURCE = "task-board-completion-sync";
const DB_NAME = process.env.CORTANA_DB ?? "cortana";

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: invalid JSON (${detail})`);
  }
}

function runSql(sql: string): string {
  const proc = runPsql(sql, {
    db: DB_NAME,
    args: ["-q", "-X", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
    env: withPostgresPath(process.env),
  });

  if (proc.status !== 0) {
    const detail = (proc.stderr || proc.stdout || "psql failed").trim();
    throw new Error(detail);
  }

  return String(proc.stdout ?? "").trim();
}

function runSqlJson<T>(sql: string, label: string): T {
  const raw = runSql(sql);
  if (!raw) throw new Error(`${label}: empty SQL result`);
  return parseJson<T>(raw, label);
}

function loadSessions(): SessionRow[] {
  const proc = spawnSync("openclaw", ["sessions", "--json", "--active", "1440", "--all-agents"], {
    cwd: repoRoot(),
    encoding: "utf8",
    env: withPostgresPath(process.env),
  });

  if (proc.status !== 0) {
    throw new Error((proc.stderr || proc.stdout || "openclaw sessions failed").trim());
  }

  const raw = String(proc.stdout ?? "").trim() || '{"sessions":[]}';
  const parsed = parseJson<SessionsPayload | SessionRow[]>(raw, "openclaw sessions");
  const sessions = Array.isArray(parsed) ? parsed : parsed.sessions ?? [];
  return sessions.filter((row) => String(row.key ?? "").includes(":subagent:"));
}

function findMatchingTask(runId: string, label: string, key: string): { id: number } | null {
  const runIdEsc = sqlEscape(runId);
  const labelEsc = sqlEscape(label);
  const keyEsc = sqlEscape(key);

  const sql = `
    SELECT COALESCE(row_to_json(t)::text, '')
    FROM (
      SELECT id
      FROM cortana_tasks
      WHERE status='in_progress'
        AND (
          (NULLIF('${runIdEsc}','') IS NOT NULL AND run_id='${runIdEsc}')
          OR (
            run_id IS NULL
            AND (
              assigned_to='${labelEsc}'
              OR assigned_to='${keyEsc}'
              OR COALESCE(metadata->>'subagent_label','')='${labelEsc}'
              OR COALESCE(metadata->>'subagent_session_key','')='${keyEsc}'
            )
          )
        )
      ORDER BY
        CASE WHEN NULLIF('${runIdEsc}','') IS NOT NULL AND run_id='${runIdEsc}' THEN 0 ELSE 1 END,
        updated_at DESC NULLS LAST,
        created_at DESC
      LIMIT 1
    ) t;
  `;

  const raw = runSql(sql);
  if (!raw) return null;
  return parseJson<{ id: number }>(raw, "matching task");
}

function syncTask(taskId: number, row: SessionRow, terminal: { outcome: "completed" | "failed"; lifecycleEvent: string }): void {
  const key = String(row.key ?? "").trim();
  const label = String(row.label ?? "").trim();
  const runId = String(row.run_id ?? row.runId ?? row.sessionId ?? "").trim();
  const status = String(row.status ?? row.lastStatus ?? "unknown").trim().toLowerCase();
  const outcomeText = sqlEscape(`Auto-synced from sub-agent ${label || key} (${status})`);
  const keyEsc = sqlEscape(key);
  const labelEsc = sqlEscape(label);
  const runIdEsc = sqlEscape(runId);
  const eventRunIdEsc = sqlEscape(runId || `session:${key}`);
  const lifecycleEsc = sqlEscape(terminal.lifecycleEvent);
  const mappedOutcomeEsc = sqlEscape(terminal.outcome);
  const statusEsc = sqlEscape(status);
  const sourceEsc = sqlEscape(SOURCE);

  const completedAtClause = terminal.outcome === "completed" ? "completed_at=COALESCE(completed_at,NOW())," : "";
  const statusTarget = sqlEscape(terminal.outcome);

  const sql = `
BEGIN;

UPDATE cortana_tasks
SET status='${statusTarget}',
    ${completedAtClause}
    outcome='${outcomeText}',
    assigned_to=NULL,
    run_id=COALESCE(NULLIF('${runIdEsc}',''), run_id),
    metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object(
      'completion_synced_at', NOW()::text,
      'subagent_status', '${statusEsc}',
      'subagent_run_id', NULLIF('${runIdEsc}','')
    )
WHERE id=${taskId} AND status='in_progress';

INSERT INTO cortana_run_events (run_id, task_id, event_type, source, metadata)
VALUES (
  '${eventRunIdEsc}',
  ${taskId},
  '${lifecycleEsc}',
  '${sourceEsc}',
  jsonb_build_object(
    'session_key','${keyEsc}',
    'label',NULLIF('${labelEsc}',''),
    'raw_run_id',NULLIF('${runIdEsc}',''),
    'status','${statusEsc}',
    'mapped_outcome','${mappedOutcomeEsc}'
  )
);

INSERT INTO cortana_events (event_type, source, severity, message, metadata)
VALUES (
  'task_completion_synced',
  '${sourceEsc}',
  'info',
  'Synced task #${taskId} from sub-agent ${sqlEscape(label || key)} -> ${statusTarget}',
  jsonb_build_object(
    'task_id',${taskId},
    'session_key','${keyEsc}',
    'label',NULLIF('${labelEsc}',''),
    'run_id',NULLIF('${runIdEsc}',''),
    'status','${statusEsc}',
    'mapped_outcome','${mappedOutcomeEsc}',
    'lifecycle_event','${lifecycleEsc}'
  )
);

COMMIT;
`;

  runSql(sql);
}

export async function run(): Promise<CompletionSyncReport> {
  const operationId = generateOperationId();
  const operationType = "completion_sync_pass";

  if (checkIdempotency(operationId)) {
    logIdempotency(operationId, operationType, "skipped", compactJson({ reason: "already_completed" }));
    return {
      ok: true,
      skipped: true,
      reason: "idempotent_operation_already_completed",
      synced_count: 0,
      synced: [],
    };
  }

  logIdempotency(operationId, operationType, "started", "{}");

  const sessions = loadSessions();
  const synced: CompletionResult[] = [];

  for (const row of sessions) {
    const terminal = classifyTerminalOutcome(row);
    if (!terminal) continue;

    const key = String(row.key ?? "").trim();
    const label = String(row.label ?? "").trim();
    const runId = String(row.run_id ?? row.runId ?? row.sessionId ?? "").trim();
    const status = String(row.status ?? row.lastStatus ?? "unknown").trim().toLowerCase();
    const task = findMatchingTask(runId, label, key);
    if (!task) continue;

    syncTask(task.id, row, terminal);
    synced.push({
      task_id: task.id,
      label,
      session_key: key,
      run_id: runId,
      status,
      mapped_outcome: terminal.outcome,
    });
  }

  logIdempotency(operationId, operationType, "completed", compactJson({ synced_count: synced.length }));
  return { ok: true, synced_count: synced.length, synced };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then((report) => {
      process.stdout.write(`${compactJson(report)}\n`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
