#!/usr/bin/env npx tsx

import { query } from "../lib/db.js";

type Json = Record<string, any>;

const SOURCE = "state_integrity";

function sqlEscape(text: string): string {
  return text.replace(/'/g, "''");
}

function runPsql(sql: string): string {
  return query(sql).trim();
}

function fetchJson(sql: string): Array<Record<string, any>> {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t;`;
  const raw = runPsql(wrapped);
  return raw ? (JSON.parse(raw) as Array<Record<string, any>>) : [];
}

function logEvent(eventType: string, severity: string, message: string, metadata: Json, dryRun: boolean): void {
  if (dryRun) return;
  const meta = sqlEscape(JSON.stringify(metadata));
  runPsql(
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES " +
      `('${sqlEscape(eventType)}', '${SOURCE}', '${sqlEscape(severity)}', ` +
      `'${sqlEscape(message)}', '${meta}'::jsonb);`
  );
}

function fixDoneMissingCompletedAt(limit: number, dryRun: boolean): number[] {
  const rows = fetchJson(
    "SELECT id FROM cortana_tasks " +
      "WHERE status='completed' AND completed_at IS NULL " +
      `ORDER BY id ASC LIMIT ${Math.max(1, limit)}`
  );
  const ids = rows.map((r) => Number(r.id));
  if (ids.length && !dryRun) {
    runPsql(
      "UPDATE cortana_tasks SET completed_at = NOW(), updated_at = CURRENT_TIMESTAMP " +
        `WHERE id = ANY(ARRAY[${ids.join(",")} ]::int[]) AND completed_at IS NULL;`
    );
  }
  if (ids.length) {
    logEvent(
      "auto_heal",
      "info",
      `Filled completed_at for ${ids.length} completed task(s)`,
      { task_ids: ids, fix: "set_completed_at_now", dry_run: dryRun },
      dryRun
    );
  }
  return ids;
}


function fixCompletedWithAssignedTo(limit: number, dryRun: boolean): number[] {
  const rows = fetchJson(
    "SELECT id FROM cortana_tasks " +
      "WHERE status='completed' AND assigned_to IS NOT NULL " +
      `ORDER BY id ASC LIMIT ${Math.max(1, limit)}`
  );
  const ids = rows.map((r) => Number(r.id));
  if (ids.length && !dryRun) {
    runPsql(
      "UPDATE cortana_tasks SET assigned_to = NULL, updated_at = CURRENT_TIMESTAMP, " +
        "metadata = COALESCE(metadata, '{}'::jsonb) || " +
        "jsonb_build_object('ownership_hygiene_auto_heal', jsonb_build_object('at', NOW(), 'reason', 'completed_task_assigned_to_cleared')), " +
        "outcome = CASE " +
        "WHEN COALESCE(outcome,'') = '' THEN 'Ownership hygiene auto-heal: cleared stale assigned_to on completed task.' " +
        "WHEN POSITION('Ownership hygiene auto-heal: cleared stale assigned_to on completed task.' IN outcome) > 0 THEN outcome " +
        "ELSE outcome || E'\nOwnership hygiene auto-heal: cleared stale assigned_to on completed task.' END " +
        `WHERE id = ANY(ARRAY[${ids.join(",")}]::int[]) AND status='completed' AND assigned_to IS NOT NULL;`
    );
  }
  if (ids.length) {
    logEvent(
      "auto_heal",
      "warning",
      `Cleared stale assigned_to for ${ids.length} completed task(s)`,
      { task_ids: ids, fix: "completed_with_assigned_to", dry_run: dryRun },
      dryRun
    );
  }
  return ids;
}

function detectOrphanedInProgress(orphanMinutes: number, limit: number): Json[] {
  return fetchJson(
    "SELECT t.id, t.title, t.assigned_to, t.updated_at, t.created_at " +
      "FROM cortana_tasks t " +
      "WHERE t.status='in_progress' " +
      `  AND COALESCE(t.updated_at, t.created_at, NOW()) < NOW() - INTERVAL '${Math.max(
        1,
        orphanMinutes
      )} minutes' ` +
      "  AND NOT EXISTS (" +
      "    SELECT 1 FROM cortana_covenant_runs r " +
      "    WHERE (r.status = 'running' OR r.ended_at IS NULL) " +
      "      AND (" +
      "        (t.run_id IS NOT NULL AND r.session_key = t.run_id) " +
      "        OR (" +
      "          t.run_id IS NULL " +
      "          AND t.assigned_to IS NOT NULL " +
      "          AND (r.agent = t.assigned_to OR r.session_key = t.assigned_to)" +
      "        )" +
      "      )" +
      "  ) " +
      "ORDER BY COALESCE(t.updated_at, t.created_at) ASC " +
      `LIMIT ${Math.max(1, limit)}`
  );
}

function detectCompletedWithPendingChildren(limit: number): Json[] {
  return fetchJson(
    "SELECT p.id AS parent_id, p.title AS parent_title, COUNT(c.id)::int AS pending_children " +
      "FROM cortana_tasks p " +
      "JOIN cortana_tasks c ON c.parent_id = p.id " +
      "WHERE p.status='completed' AND c.status IN ('ready', 'in_progress', 'backlog') " +
      "GROUP BY p.id, p.title " +
      "ORDER BY pending_children DESC, p.id ASC " +
      `LIMIT ${Math.max(1, limit)}`
  );
}

function detectReadyWithActiveRun(limit: number): Json[] {
  return fetchJson(
    "SELECT t.id, t.title, t.assigned_to, t.run_id, t.updated_at, t.created_at " +
      "FROM cortana_tasks t " +
      "WHERE t.status='ready' " +
      "  AND EXISTS (" +
      "    SELECT 1 FROM cortana_covenant_runs r " +
      "    WHERE (r.status = 'running' OR r.ended_at IS NULL) " +
      "      AND ((t.run_id IS NOT NULL AND r.session_key = t.run_id) " +
      "        OR (t.assigned_to IS NOT NULL AND (r.agent = t.assigned_to OR r.session_key = t.assigned_to))" +
      "      )" +
      "  ) " +
      "ORDER BY COALESCE(t.updated_at, t.created_at) ASC " +
      `LIMIT ${Math.max(1, limit)}`
  );
}

function healReadyWithActiveRun(rows: Json[], dryRun: boolean): number[] {
  const ids = rows.map((r) => Number(r.id)).filter((id) => Number.isFinite(id));
  if (ids.length && !dryRun) {
    runPsql(
      "UPDATE cortana_tasks SET status='in_progress', updated_at = CURRENT_TIMESTAMP, " +
        "metadata = COALESCE(metadata, '{}'::jsonb) || " +
        "jsonb_build_object('auto_heal_spawn_state', jsonb_build_object('at', NOW(), 'reason', 'ready_with_active_run')) " +
        `WHERE id = ANY(ARRAY[${ids.join(",")}]::int[]) AND status='ready';`
    );
  }
  if (ids.length) {
    logEvent(
      "auto_heal",
      "warning",
      `Moved ${ids.length} task(s) ready -> in_progress due to active run evidence`,
      { task_ids: ids, fix: "ready_with_active_run", dry_run: dryRun },
      dryRun
    );
  }
  return ids;
}

function audit(orphanMinutes: number, fixLimit: number, detectLimit: number, dryRun: boolean, healReadyActiveRun: boolean): Json {
  const fixedDone = fixDoneMissingCompletedAt(fixLimit, dryRun);
  const fixedCompletedAssigned = fixCompletedWithAssignedTo(fixLimit, dryRun);
  const orphaned = detectOrphanedInProgress(orphanMinutes, detectLimit);
  const completedWithPending = detectCompletedWithPendingChildren(detectLimit);
  const readyWithActiveRun = detectReadyWithActiveRun(detectLimit);
  const healedReadyWithActiveRun = healReadyActiveRun ? healReadyWithActiveRun(readyWithActiveRun, dryRun) : [];

  if (orphaned.length) {
    logEvent(
      "integrity_warning",
      "warning",
      `Detected ${orphaned.length} orphaned in_progress task(s)`,
      { orphaned_tasks: orphaned, orphan_minutes: orphanMinutes, dry_run: dryRun },
      dryRun
    );
  }

  if (completedWithPending.length) {
    logEvent(
      "integrity_warning",
      "warning",
      `Detected ${completedWithPending.length} completed parent task(s) with pending children`,
      { mismatches: completedWithPending, dry_run: dryRun },
      dryRun
    );
  }

  if (readyWithActiveRun.length) {
    logEvent(
      "integrity_warning",
      "warning",
      `Detected ${readyWithActiveRun.length} ready task(s) with active run evidence`,
      {
        ready_with_active_run: readyWithActiveRun,
        healed: healReadyActiveRun,
        healed_ids: healedReadyWithActiveRun,
        dry_run: dryRun,
      },
      dryRun
    );
  }

  return {
    status: "ok",
    dry_run: dryRun,
    heal_ready_active_run: healReadyActiveRun,
    fixed: {
      done_missing_completed_at: fixedDone.length,
      completed_with_assigned_to: fixedCompletedAssigned.length,
      task_ids: Array.from(new Set([...fixedDone, ...fixedCompletedAssigned])),
    },
    healed: { ready_with_active_run: healedReadyWithActiveRun.length, task_ids: healedReadyWithActiveRun },
    detected: {
      orphaned_in_progress: orphaned,
      completed_with_pending_children: completedWithPending,
      ready_with_active_run: readyWithActiveRun,
    },
  };
}

type Args = {
  orphanMinutes: number;
  fixLimit: number;
  detectLimit: number;
  dryRun: boolean;
  healReadyActiveRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { orphanMinutes: 30, fixLimit: 200, detectLimit: 200, dryRun: false, healReadyActiveRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--orphan-minutes":
        args.orphanMinutes = Number(argv[i + 1]);
        i += 1;
        break;
      case "--fix-limit":
        args.fixLimit = Number(argv[i + 1]);
        i += 1;
        break;
      case "--detect-limit":
        args.detectLimit = Number(argv[i + 1]);
        i += 1;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--heal-ready-active-run":
        args.healReadyActiveRun = true;
        break;
      default:
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = audit(args.orphanMinutes, args.fixLimit, args.detectLimit, args.dryRun, args.healReadyActiveRun);
    console.log(JSON.stringify(report));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ status: "error", error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
