#!/usr/bin/env npx tsx

import { spawnSync } from "child_process";
import db from "../lib/db.js";
const { runPsql, withPostgresPath } = db;

type Json = Record<string, any>;

type TaskRow = {
  id: number;
  title: string;
  status: string;
  assigned_to: string | null;
  run_id: string | null;
  outcome: string | null;
  metadata: Json | null;
};

type SessionRow = {
  key?: string;
  label?: string | null;
  status?: string | null;
  lastStatus?: string | null;
  ageMs?: number;
  abortedLastRun?: boolean;
  run_id?: string;
  runId?: string;
  sessionId?: string;
};

type Action = {
  taskId: number;
  action: "complete_merged_pr" | "mark_in_progress" | "revert_failed_to_ready";
  reason: string;
  details: Json;
};

function isRetryPendingFailed(task: TaskRow): boolean {
  if (task.status !== "failed") return false;
  const md = task.metadata || {};
  const out = lower(task.outcome || "");
  return Boolean(
    md.retry_pending === true ||
      md.manual_fallback === true ||
      md.manual_retry_requested === true ||
      md.retry_requested_at ||
      md.retry_after ||
      out.includes("retry pending") ||
      out.includes("manual fallback") ||
      out.includes("retry requested")
  );
}

const DB_NAME = process.env.CORTANA_DB ?? "cortana";
const SOURCE = "task-board-aggressive-reconcile";
const TERMINAL = new Set(["ok", "done", "completed", "success", "failed", "error", "timeout", "timed_out", "killed", "terminated", "aborted", "cancelled", "canceled"]);

function parseArgs(argv: string[]) {
  const argValue = (name: string, fallback: string): number => {
    const idx = argv.indexOf(name);
    if (idx < 0 || !argv[idx + 1]) return Number(fallback);
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) ? n : Number(fallback);
  };

  return {
    apply: argv.includes("--apply"),
    pretty: argv.includes("--pretty"),
    activeMinutes: argValue("--active-minutes", "180"),
    maxTasks: argValue("--max-tasks", "500"),
  };
}

function emit(obj: Json, pretty = false): void {
  const doc = { ts: new Date().toISOString(), source: SOURCE, ...obj };
  process.stdout.write(`${JSON.stringify(doc, null, pretty ? 2 : 0)}\n`);
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runSql(sql: string): string {
  const proc = runPsql(sql, { db: DB_NAME, args: ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"], env: withPostgresPath(process.env) });
  if (proc.status !== 0) {
    throw new Error((proc.stderr || proc.stdout || "psql failed").trim());
  }
  return (proc.stdout || "").trim();
}

function loadTasks(maxTasks: number): TaskRow[] {
  const raw = runSql(`
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text
    FROM (
      SELECT id, title, status, assigned_to, run_id, outcome, metadata
      FROM cortana_tasks
      WHERE status IN ('ready','in_progress','failed')
      ORDER BY id DESC
      LIMIT ${Math.max(1, maxTasks)}
    ) t;
  `);
  return JSON.parse(raw || "[]");
}

function loadSessions(activeMinutes: number): SessionRow[] {
  const proc = spawnSync("openclaw", ["sessions", "--json", "--active", String(activeMinutes), "--all-agents"], {
    encoding: "utf8",
    env: withPostgresPath(process.env),
  });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "openclaw sessions failed").trim());
  const parsed = JSON.parse(proc.stdout || "{}");
  return Array.isArray(parsed.sessions) ? parsed.sessions : [];
}

export function lower(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

export function isActiveSession(s: SessionRow): boolean {
  if (s.abortedLastRun === true) return false;
  const st = lower(s.status || s.lastStatus);
  return !st || !TERMINAL.has(st);
}

function findPrRef(task: TaskRow): { repo: string; number: number; url?: string } | null {
  const md = task.metadata || {};
  const candidates = [md.pr_number, md.prNumber, md.pull_request_number, md.github_pr_number]
    .map((x: any) => Number(x))
    .filter((n: number) => Number.isFinite(n) && n > 0);
  let repo = String(md.repo || md.github_repo || "").trim();
  let num = candidates[0] ?? 0;
  const url = String(md.pr_url || md.pull_request_url || md.github_pr_url || "").trim();

  if ((!repo || !num) && url.includes("github.com")) {
    const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
    if (m) {
      repo = repo || m[1];
      if (!num) num = Number(m[2]);
    }
  }

  if (repo && num > 0) return { repo, number: num, url: url || undefined };
  return null;
}

function ghPrMerged(repo: string, num: number): { merged: boolean; mergedAt: string | null; url: string | null } {
  const proc = spawnSync("gh", ["pr", "view", String(num), "--repo", repo, "--json", "state,mergedAt,url"], {
    encoding: "utf8",
    env: withPostgresPath(process.env),
  });
  if (proc.status !== 0) return { merged: false, mergedAt: null, url: null };
  const parsed = JSON.parse(proc.stdout || "{}");
  return {
    merged: Boolean(parsed?.state === "MERGED" || parsed?.mergedAt),
    mergedAt: parsed?.mergedAt ?? null,
    url: parsed?.url ?? null,
  };
}

function isAmbiguousFailed(task: TaskRow): boolean {
  if (task.status !== "failed") return false;
  const md = task.metadata || {};
  const subStatus = lower(md.subagent_status);
  const reason = lower(md.normalization_reason);
  const out = lower(task.outcome || "");
  return (
    reason.includes("autosync_unknown_status_false_failure") ||
    subStatus === "unknown" ||
    (out.includes("auto-synced") && out.includes("unknown")) ||
    (Boolean(md.completion_synced_at) && !subStatus)
  );
}

export function pickActions(tasks: TaskRow[], sessions: SessionRow[]): Action[] {
  const actions: Action[] = [];
  const activeSessions = sessions.filter((s) => String(s.key || "").includes(":subagent:") && isActiveSession(s));

  const activeIds = new Set<string>();
  for (const s of activeSessions) {
    for (const v of [s.run_id, s.runId, s.sessionId, s.key, s.label]) {
      const k = String(v || "").trim();
      if (k) activeIds.add(k);
    }
  }

  const prCache = new Map<string, ReturnType<typeof ghPrMerged>>();

  for (const task of tasks) {
    const md = task.metadata || {};
    const refs = [task.run_id, md.subagent_run_id, md.subagent_session_key, md.subagent_label, task.assigned_to].map((v) => String(v || "").trim()).filter(Boolean);
    const hasActiveRun = refs.some((r) => activeIds.has(r));

    const pr = findPrRef(task);
    if (pr && task.status !== "completed") {
      const key = `${pr.repo}#${pr.number}`;
      if (!prCache.has(key)) prCache.set(key, ghPrMerged(pr.repo, pr.number));
      const st = prCache.get(key)!;
      if (st.merged) {
        actions.push({
          taskId: task.id,
          action: "complete_merged_pr",
          reason: `Linked PR merged (${pr.repo}#${pr.number})`,
          details: { pr: { ...pr, mergedAt: st.mergedAt, resolvedUrl: st.url } },
        });
        continue;
      }
    }

    if (hasActiveRun && task.status !== "in_progress") {
      actions.push({
        taskId: task.id,
        action: "mark_in_progress",
        reason: "Active sub-agent run detected",
        details: { refs },
      });
      continue;
    }

    if (!hasActiveRun && isAmbiguousFailed(task)) {
      actions.push({
        taskId: task.id,
        action: "revert_failed_to_ready",
        reason: "Failed state appears autosync-ambiguous; reverting to ready",
        details: { refs, mode: "ambiguous_autosync" },
      });
      continue;
    }

    if (!hasActiveRun && isRetryPendingFailed(task)) {
      actions.push({
        taskId: task.id,
        action: "revert_failed_to_ready",
        reason: "Retry/manual fallback marker detected; reverting failed -> ready",
        details: { refs, mode: "retry_pending" },
      });
    }
  }

  const dedup = new Map<number, Action>();
  for (const a of actions) {
    if (!dedup.has(a.taskId)) dedup.set(a.taskId, a);
  }
  return Array.from(dedup.values());
}

function applyAction(a: Action): void {
  const metaPatch = {
    aggressive_reconcile: {
      at: new Date().toISOString(),
      source: SOURCE,
      action: a.action,
      reason: a.reason,
      details: a.details,
    },
  };
  const patchSql = sqlQuote(JSON.stringify(metaPatch));

  if (a.action === "complete_merged_pr") {
    runSql(`
      UPDATE cortana_tasks
      SET status='completed',
          completed_at=COALESCE(completed_at, NOW()),
          outcome=CASE WHEN COALESCE(outcome,'')='' THEN ${sqlQuote(a.reason)} ELSE outcome END,
          metadata=COALESCE(metadata,'{}'::jsonb) || ${patchSql}::jsonb
      WHERE id=${a.taskId};

      INSERT INTO cortana_events (event_type, source, severity, message, metadata)
      VALUES ('task_state_reconciled', ${sqlQuote(SOURCE)}, 'info', ${sqlQuote(`Task #${a.taskId} auto-completed from merged PR`)},
              jsonb_build_object('task_id',${a.taskId},'action',${sqlQuote(a.action)},'reason',${sqlQuote(a.reason)},'details',${patchSql}::jsonb));
    `);
    return;
  }

  if (a.action === "mark_in_progress") {
    runSql(`
      UPDATE cortana_tasks
      SET status='in_progress',
          metadata=COALESCE(metadata,'{}'::jsonb) || ${patchSql}::jsonb
      WHERE id=${a.taskId};

      INSERT INTO cortana_events (event_type, source, severity, message, metadata)
      VALUES ('task_state_reconciled', ${sqlQuote(SOURCE)}, 'info', ${sqlQuote(`Task #${a.taskId} set in_progress from active run`)},
              jsonb_build_object('task_id',${a.taskId},'action',${sqlQuote(a.action)},'reason',${sqlQuote(a.reason)},'details',${patchSql}::jsonb));
    `);
    return;
  }

  runSql(`
    UPDATE cortana_tasks
    SET status='ready',
        outcome=${sqlQuote(a.reason)},
        metadata=COALESCE(metadata,'{}'::jsonb) || ${patchSql}::jsonb
    WHERE id=${a.taskId} AND status='failed';

    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES ('task_state_reconciled', ${sqlQuote(SOURCE)}, 'warning', ${sqlQuote(`Task #${a.taskId} reverted failed->ready (ambiguous autosync)`)},
            jsonb_build_object('task_id',${a.taskId},'action',${sqlQuote(a.action)},'reason',${sqlQuote(a.reason)},'details',${patchSql}::jsonb));
  `);
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(args.maxTasks);
  const sessions = loadSessions(args.activeMinutes);
  const actions = pickActions(tasks, sessions);

  if (args.apply) {
    for (const a of actions) applyAction(a);
  }

  emit(
    {
      ok: true,
      mode: args.apply ? "apply" : "dry_run",
      scanned: { tasks: tasks.length, sessions: sessions.length },
      action_count: actions.length,
      actions,
    },
    args.pretty
  );
}

if (process.argv[1] && process.argv[1].includes("aggressive-reconcile.ts")) {
  main().catch((err) => {
    emit({ ok: false, error: err instanceof Error ? err.message : String(err) }, true);
    process.exit(1);
  });
}
