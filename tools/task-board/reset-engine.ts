#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { repoRoot } from "../lib/paths.js";
import { runPsql, withPostgresPath } from "../lib/db.js";

type Json = Record<string, any>;

type StepResult = {
  name: string;
  data: Json;
};

type ResetSummary = {
  syncedCount: number;
  reconciledCount: number;
  staleFlaggedCount: number;
  orphanResetCount: number;
  scheduledPromotedCount: number;
  staleClosedCount: number;
};

type MissionTask = {
  id: number;
  title: string;
  status: "ready" | "in_progress" | "scheduled";
  priority: number | null;
  due_at: string | null;
  execute_at: string | null;
  created_at: string | null;
};

type ResetReport = {
  ok: true;
  generated_at: string;
  summary: ResetSummary;
  steps: {
    completionSync: Json;
    aggressiveReconcile: Json;
    staleDetector: Json;
    scheduledPromotion: Json;
    staleClosure: Json;
  };
  mission_stack: {
    date: string;
    mit: string | null;
    task_ids: number[];
    output: string;
  };
};

const SOURCE = "task-board-reset-engine";
const DB_NAME = process.env.CORTANA_DB ?? "cortana";
const STALE_AUTO_CLOSE_AFTER_DAYS = 14;
const STALE_FLAG_GRACE_DAYS = 3;
const MAX_STACK_TASKS = 5;

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: invalid JSON output (${detail})`);
  }
}

function runJsonCommand(name: string, args: string[]): Json {
  const proc = spawnSync(args[0]!, args.slice(1), {
    cwd: repoRoot(),
    encoding: "utf8",
    env: withPostgresPath(process.env),
  });
  if (proc.status !== 0) {
    const detail = (proc.stderr || proc.stdout || `${name} failed`).trim();
    throw new Error(`${name}: ${detail}`);
  }

  const raw = `${proc.stdout || ""}`.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  if (!raw) throw new Error(`${name}: empty output`);
  return parseJson<Json>(raw, name);
}

function runSqlJson<T>(sql: string, label: string): T {
  const proc = runPsql(sql, {
    db: DB_NAME,
    args: ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
    env: withPostgresPath(process.env),
  });
  if (proc.status !== 0) {
    const detail = (proc.stderr || proc.stdout || "psql failed").trim();
    throw new Error(`${label}: ${detail}`);
  }

  const raw = `${proc.stdout || ""}`.trim();
  if (!raw) throw new Error(`${label}: empty SQL result`);
  return parseJson<T>(raw, label);
}

function promoteScheduledTasks(): Json {
  return runSqlJson<Json>(
    `
WITH promoted AS (
  UPDATE cortana_tasks t
  SET status = 'ready',
      updated_at = CURRENT_TIMESTAMP,
      metadata = COALESCE(t.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'scheduled_promoted',
          jsonb_build_object(
            'at', NOW(),
            'reason', 'execute_at_due_reset_engine'
          )
        )
  WHERE t.status = 'scheduled'
    AND t.execute_at IS NOT NULL
    AND t.execute_at <= NOW()
  RETURNING t.id, t.title, t.priority, t.execute_at, t.status, t.metadata
), events AS (
  INSERT INTO cortana_events (event_type, source, severity, message, metadata)
  SELECT
    'task_scheduled_promoted',
    ${sqlQuote(SOURCE)},
    'info',
    format('Promoted scheduled task %s to ready', p.id::text),
    jsonb_build_object(
      'operation', 'task-board-reset',
      'action', 'promote_scheduled_to_ready',
      'task_id', p.id,
      'title', p.title,
      'execute_at', p.execute_at
    )
  FROM promoted p
  RETURNING id
)
SELECT json_build_object(
  'count', (SELECT COUNT(*) FROM promoted),
  'tasks', COALESCE((SELECT json_agg(promoted) FROM promoted), '[]'::json),
  'event_ids', COALESCE((SELECT json_agg(id) FROM events), '[]'::json)
)::text;
`,
    "scheduled-promotion"
  );
}

function closeStaleReadyTasks(): Json {
  return runSqlJson<Json>(
    `
WITH candidates AS (
  SELECT
    t.id,
    t.title,
    t.priority,
    t.due_at,
    COALESCE(t.updated_at, t.created_at) AS last_activity_at,
    COALESCE(
      NULLIF(t.metadata->>'stale_flagged_at', '')::timestamptz,
      COALESCE(t.updated_at, t.created_at)
    ) AS stale_flagged_at
  FROM cortana_tasks t
  WHERE t.status = 'ready'
    AND COALESCE((t.metadata->>'stale_flagged')::boolean, false) = true
    AND COALESCE(t.updated_at, t.created_at) < NOW() - INTERVAL '${STALE_AUTO_CLOSE_AFTER_DAYS} days'
    AND COALESCE(
      NULLIF(t.metadata->>'stale_flagged_at', '')::timestamptz,
      COALESCE(t.updated_at, t.created_at)
    ) < NOW() - INTERVAL '${STALE_FLAG_GRACE_DAYS} days'
  FOR UPDATE
), closed AS (
  UPDATE cortana_tasks t
  SET status = 'cancelled',
      completed_at = COALESCE(t.completed_at, NOW()),
      assigned_to = NULL,
      outcome = CASE
        WHEN COALESCE(t.outcome, '') = '' THEN 'Auto-closed by reset engine after stale-ready grace period.'
        WHEN POSITION('Auto-closed by reset engine after stale-ready grace period.' IN t.outcome) > 0 THEN t.outcome
        ELSE t.outcome || E'\\nAuto-closed by reset engine after stale-ready grace period.'
      END,
      metadata = COALESCE(t.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'auto_closed',
          jsonb_build_object(
            'at', NOW(),
            'source', ${sqlQuote(SOURCE)},
            'reason', 'ready_stale_flagged_grace_elapsed',
            'grace_days', ${STALE_FLAG_GRACE_DAYS},
            'total_age_days', ${STALE_AUTO_CLOSE_AFTER_DAYS}
          )
        ),
      updated_at = CURRENT_TIMESTAMP
  WHERE t.id IN (SELECT id FROM candidates)
  RETURNING t.id, t.title, t.priority, t.due_at, t.status, t.outcome, t.metadata
), events AS (
  INSERT INTO cortana_events (event_type, source, severity, message, metadata)
  SELECT
    'task_auto_closed_stale',
    ${sqlQuote(SOURCE)},
    'warning',
    format('Auto-closed stale ready task %s', c.id::text),
    jsonb_build_object(
      'operation', 'task-board-reset',
      'action', 'auto_close_stale_ready',
      'task_id', c.id,
      'title', c.title,
      'reason', 'ready_stale_flagged_grace_elapsed'
    )
  FROM closed c
  RETURNING id
)
SELECT json_build_object(
  'count', (SELECT COUNT(*) FROM closed),
  'tasks', COALESCE((SELECT json_agg(closed) FROM closed), '[]'::json),
  'event_ids', COALESCE((SELECT json_agg(id) FROM events), '[]'::json),
  'policy', json_build_object(
    'ready_age_days', ${STALE_AUTO_CLOSE_AFTER_DAYS},
    'stale_flag_grace_days', ${STALE_FLAG_GRACE_DAYS}
  )
)::text;
`,
    "stale-closure"
  );
}

function loadMissionTasks(): MissionTask[] {
  return runSqlJson<MissionTask[]>(
    `
SELECT COALESCE(json_agg(t), '[]'::json)::text
FROM (
  SELECT id, title, status, priority, due_at, execute_at, created_at
  FROM cortana_tasks
  WHERE status IN ('ready', 'in_progress', 'scheduled')
  ORDER BY priority ASC NULLS LAST, created_at ASC
  LIMIT 100
) t;
`,
    "load-mission-tasks"
  );
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function inRange(value: Date | null, start: Date, end: Date): boolean {
  if (!value) return false;
  const ts = value.getTime();
  return ts >= start.getTime() && ts < end.getTime();
}

function shorten(text: string, max = 88): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function statusMarker(status: MissionTask["status"]): string {
  switch (status) {
    case "in_progress":
      return "⏳";
    case "scheduled":
      return "🗓️";
    default:
      return "🟢";
  }
}

function rankTask(task: MissionTask, now: Date): number {
  const tomorrowStart = startOfLocalDay(addDays(now, 1));
  const dayAfterTomorrow = startOfLocalDay(addDays(now, 2));
  const dueAt = parseDate(task.due_at);
  const executeAt = parseDate(task.execute_at);

  if (task.status === "in_progress") return 0;
  if (dueAt && dueAt.getTime() < tomorrowStart.getTime()) return 1;
  if (inRange(dueAt, tomorrowStart, dayAfterTomorrow)) return 2;
  if (executeAt && executeAt.getTime() < tomorrowStart.getTime()) return 3;
  if (inRange(executeAt, tomorrowStart, dayAfterTomorrow)) return 4;
  if (task.status === "ready") return 5;
  return 6;
}

export function selectTomorrowMissionTasks(tasks: MissionTask[], now = new Date()): MissionTask[] {
  return [...tasks]
    .sort((a, b) => {
      const band = rankTask(a, now) - rankTask(b, now);
      if (band !== 0) return band;

      const pa = a.priority ?? 3;
      const pb = b.priority ?? 3;
      if (pa !== pb) return pa - pb;

      const da = parseDate(a.due_at)?.getTime() ?? Number.POSITIVE_INFINITY;
      const db = parseDate(b.due_at)?.getTime() ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;

      const ea = parseDate(a.execute_at)?.getTime() ?? Number.POSITIVE_INFINITY;
      const eb = parseDate(b.execute_at)?.getTime() ?? Number.POSITIVE_INFINITY;
      if (ea !== eb) return ea - eb;

      const ca = parseDate(a.created_at)?.getTime() ?? Number.POSITIVE_INFINITY;
      const cb = parseDate(b.created_at)?.getTime() ?? Number.POSITIVE_INFINITY;
      if (ca !== cb) return ca - cb;

      return a.id - b.id;
    })
    .slice(0, MAX_STACK_TASKS);
}

function formatTomorrowLabel(now = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(addDays(now, 1));
}

export function renderTomorrowMissionStack(tasks: MissionTask[], summary: ResetSummary, now = new Date()): string {
  const label = formatTomorrowLabel(now);
  const selected = selectTomorrowMissionTasks(tasks, now);
  const rows = [
    `🎯 Tomorrow Mission Stack - ${label}`,
    `Reset: synced ${summary.syncedCount}, reconciled ${summary.reconciledCount}, reset ${summary.orphanResetCount}, promoted ${summary.scheduledPromotedCount}, closed ${summary.staleClosedCount} stale.`,
  ];

  if (selected.length === 0) {
    rows.push("MIT: Keep the board clear and protect one deep-work block early.");
    rows.push("1. No open ready work after reset. Use tomorrow to pull the next priority into focus on purpose.");
    return rows.join("\n");
  }

  rows.push(`MIT: ${shorten(selected[0]!.title, 96)}`);
  selected.forEach((task, index) => {
    rows.push(`${index + 1}. ${statusMarker(task.status)} ${shorten(task.title)}`);
  });
  return rows.join("\n");
}

function emitSummaryEvent(report: ResetReport): void {
  const metadata = JSON.stringify({
    summary: report.summary,
    mission_stack: {
      date: report.mission_stack.date,
      mit: report.mission_stack.mit,
      task_ids: report.mission_stack.task_ids,
    },
  });

  const sql = `
INSERT INTO cortana_events (event_type, source, severity, message, metadata)
VALUES (
  'task_board_reset_engine_run',
  ${sqlQuote(SOURCE)},
  'info',
  ${sqlQuote(
    `Task board reset complete: synced=${report.summary.syncedCount}, promoted=${report.summary.scheduledPromotedCount}, closed=${report.summary.staleClosedCount}`
  )},
  ${sqlQuote(metadata)}::jsonb
);
`;

  const proc = runPsql(sql, {
    db: DB_NAME,
    args: ["-X", "-q", "-v", "ON_ERROR_STOP=1"],
    env: withPostgresPath(process.env),
  });

  if (proc.status !== 0) {
    const detail = (proc.stderr || proc.stdout || "psql failed").trim();
    throw new Error(`summary-event: ${detail}`);
  }
}

export function buildResetReport(now = new Date()): ResetReport {
  const completionSync = runJsonCommand("completion-sync", ["npx", "tsx", "tools/task-board/completion-sync.ts"]);
  const aggressiveReconcile = runJsonCommand("aggressive-reconcile", [
    "npx",
    "tsx",
    "tools/task-board/aggressive-reconcile.ts",
    "--apply",
  ]);
  const staleDetector = runJsonCommand("stale-detector", ["npx", "tsx", "tools/task-board/stale-detector.ts"]);
  const scheduledPromotion = promoteScheduledTasks();
  const staleClosure = closeStaleReadyTasks();

  const tasks = loadMissionTasks();
  const summary: ResetSummary = {
    syncedCount: Number(completionSync.synced_count ?? 0),
    reconciledCount: Number(aggressiveReconcile.action_count ?? 0),
    staleFlaggedCount: Number(staleDetector.actions?.stale_pending_flagged_count ?? 0),
    orphanResetCount: Number(staleDetector.actions?.orphaned_in_progress_reset_count ?? 0),
    scheduledPromotedCount: Number(scheduledPromotion.count ?? 0),
    staleClosedCount: Number(staleClosure.count ?? 0),
  };

  const selected = selectTomorrowMissionTasks(tasks, now);
  const output = renderTomorrowMissionStack(tasks, summary, now);

  return {
    ok: true,
    generated_at: now.toISOString(),
    summary,
    steps: {
      completionSync,
      aggressiveReconcile,
      staleDetector,
      scheduledPromotion,
      staleClosure,
    },
    mission_stack: {
      date: formatTomorrowLabel(now),
      mit: selected[0]?.title ?? null,
      task_ids: selected.map((task) => task.id),
      output,
    },
  };
}

function parseArgs(argv: string[]) {
  return {
    json: argv.includes("--json"),
  };
}

export function main(argv = process.argv.slice(2)): ResetReport {
  const args = parseArgs(argv);
  const report = buildResetReport(new Date());
  emitSummaryEvent(report);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.mission_stack.output}\n`);
  }

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
