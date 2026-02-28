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
      "        (t.run_id IS NOT NULL AND r.run_id = t.run_id) " +
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

function audit(orphanMinutes: number, fixLimit: number, detectLimit: number, dryRun: boolean): Json {
  const fixedDone = fixDoneMissingCompletedAt(fixLimit, dryRun);
  const orphaned = detectOrphanedInProgress(orphanMinutes, detectLimit);
  const completedWithPending = detectCompletedWithPendingChildren(detectLimit);

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

  return {
    status: "ok",
    dry_run: dryRun,
    fixed: { done_missing_completed_at: fixedDone.length, task_ids: fixedDone },
    detected: { orphaned_in_progress: orphaned, completed_with_pending_children: completedWithPending },
  };
}

type Args = { orphanMinutes: number; fixLimit: number; detectLimit: number; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { orphanMinutes: 30, fixLimit: 200, detectLimit: 200, dryRun: false };
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
      default:
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = audit(args.orphanMinutes, args.fixLimit, args.detectLimit, args.dryRun);
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
