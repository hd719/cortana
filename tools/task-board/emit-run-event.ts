#!/usr/bin/env npx tsx

import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { withPostgresPath } from "../lib/db.js";
import { PSQL_BIN } from "../lib/paths.js";

const DB_NAME = process.env.CORTANA_DB || "cortana";

function sqlEscape(input: string): string {
  return input.replace(/'/g, "''");
}

// Usage:
//   emit_run_event <run_id> <task_id_or_empty> <event_type> <source_or_empty> <metadata_json_or_empty>
export function emitRunEvent(
  runId = "",
  taskId = "",
  eventType = "",
  source = "",
  metadata = ""
): number {
  if (!runId || !eventType) {
    return 1;
  }

  const runIdEsc = sqlEscape(runId);
  const sourceEsc = sqlEscape(source);
  const eventTypeEsc = sqlEscape(eventType);

  const metadataValue = metadata || "{}";
  const metadataEsc = sqlEscape(metadataValue);

  let taskExpr = "NULL";
  if (taskId) {
    taskExpr = taskId;
  }

  const sql = `
    INSERT INTO cortana_run_events (run_id, task_id, event_type, source, metadata)
    VALUES (
      '${runIdEsc}',
      ${taskExpr},
      '${eventTypeEsc}',
      NULLIF('${sourceEsc}',''),
      '${metadataEsc}'::jsonb
    );
  `;

  const result = spawnSync(
    PSQL_BIN,
    [DB_NAME, "-q", "-X", "-v", "ON_ERROR_STOP=1", "-c", sql],
    {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "inherit"],
      env: withPostgresPath(process.env),
    }
  );

  if (result.error) {
    return 1;
  }

  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , runId, taskId, eventType, source, metadata] = process.argv;
  process.exit(emitRunEvent(runId, taskId, eventType, source, metadata));
}
