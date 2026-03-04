#!/usr/bin/env npx tsx

import { query } from "../lib/db.js";

type GuardReport = {
  ok: boolean;
  source: string;
  checked_at: string;
  counts: {
    completed_with_assigned_to: number;
    in_progress_without_active_session_mapping: number;
    invalid_priorities: number;
  };
  samples: {
    completed_with_assigned_to: Array<Record<string, any>>;
    in_progress_without_active_session_mapping: Array<Record<string, any>>;
    invalid_priorities: Array<Record<string, any>>;
  };
};

const SOURCE = "task-board-integrity-guard";

function sqlEscape(text: string): string {
  return text.replace(/'/g, "''");
}

function fetchJson(sql: string): Array<Record<string, any>> {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t;`;
  const raw = query(wrapped).trim();
  return raw ? (JSON.parse(raw) as Array<Record<string, any>>) : [];
}

function parseArgs(argv: string[]): { pretty: boolean; sampleLimit: number; logEvent: boolean } {
  let pretty = false;
  let sampleLimit = 25;
  let logEvent = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pretty") pretty = true;
    else if (arg === "--log-event") logEvent = true;
    else if (arg === "--sample-limit") {
      sampleLimit = Number(argv[i + 1] ?? "25");
      i += 1;
    }
  }
  return { pretty, sampleLimit: Math.max(1, sampleLimit), logEvent };
}

function main(): void {
  const { pretty, sampleLimit, logEvent } = parseArgs(process.argv.slice(2));

  const completedWithAssigned = fetchJson(
    `SELECT id, title, assigned_to, completed_at, updated_at
     FROM cortana_tasks
     WHERE status='completed' AND assigned_to IS NOT NULL
     ORDER BY completed_at DESC NULLS LAST, id DESC
     LIMIT ${sampleLimit}`
  );

  const inProgressWithoutSession = fetchJson(
    `SELECT t.id, t.title, t.assigned_to, t.run_id, t.updated_at, t.created_at
     FROM cortana_tasks t
     WHERE t.status='in_progress'
       AND NOT EXISTS (
         SELECT 1
         FROM cortana_covenant_runs r
         WHERE (r.status = 'running' OR r.ended_at IS NULL)
           AND (
             (t.run_id IS NOT NULL AND r.session_key = t.run_id)
             OR (t.assigned_to IS NOT NULL AND (r.agent = t.assigned_to OR r.session_key = t.assigned_to))
           )
       )
     ORDER BY COALESCE(t.updated_at, t.created_at) ASC
     LIMIT ${sampleLimit}`
  );

  const invalidPriorities = fetchJson(
    `SELECT id, title, priority, status, source, created_at
     FROM cortana_tasks
     WHERE priority IS NULL OR priority < 1 OR priority > 5
     ORDER BY id ASC
     LIMIT ${sampleLimit}`
  );

  const report: GuardReport = {
    ok:
      completedWithAssigned.length === 0 &&
      inProgressWithoutSession.length === 0 &&
      invalidPriorities.length === 0,
    source: SOURCE,
    checked_at: new Date().toISOString(),
    counts: {
      completed_with_assigned_to: completedWithAssigned.length,
      in_progress_without_active_session_mapping: inProgressWithoutSession.length,
      invalid_priorities: invalidPriorities.length,
    },
    samples: {
      completed_with_assigned_to: completedWithAssigned,
      in_progress_without_active_session_mapping: inProgressWithoutSession,
      invalid_priorities: invalidPriorities,
    },
  };

  if (logEvent) {
    const severity = report.ok ? "info" : "warning";
    const message = report.ok
      ? "Task-board integrity guard passed"
      : "Task-board integrity guard found violations";
    const metadata = sqlEscape(JSON.stringify(report));
    query(
      "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES " +
        `('task_board_integrity_guard', '${SOURCE}', '${severity}', '${sqlEscape(message)}', '${metadata}'::jsonb);`
    );
  }

  if (pretty) {
    console.log(`task-board integrity guard :: ok=${report.ok}`);
    console.log(`- completed+assigned_to: ${report.counts.completed_with_assigned_to}`);
    console.log(`- in_progress without active session mapping: ${report.counts.in_progress_without_active_session_mapping}`);
    console.log(`- invalid priorities: ${report.counts.invalid_priorities}`);
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
