#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { withPostgresPath } from "../lib/db.js";
import { PSQL_BIN } from "../lib/paths.js";

function run(db: string, sql: string): number {
  const r = spawnSync(PSQL_BIN, [db, "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    env: withPostgresPath(process.env),
  });
  return r.status ?? 1;
}

async function main(): Promise<void> {
  const db = process.env.DB_NAME || "cortana";
  const mode = process.argv[2] ?? "--install";

  const installSql = `
CREATE OR REPLACE FUNCTION sync_feedback_remediation_from_task()
RETURNS trigger AS $$
DECLARE
  fb_id uuid;
BEGIN
  IF NEW.metadata ? 'feedback_id' THEN
    BEGIN
      fb_id := (NEW.metadata->>'feedback_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN NEW;
    END;

    IF NEW.status = 'in_progress' THEN
      UPDATE mc_feedback_items
      SET remediation_status = 'in_progress', updated_at = NOW()
      WHERE id = fb_id;
    ELSIF NEW.status = 'completed' THEN
      UPDATE mc_feedback_items
      SET remediation_status = 'resolved',
          resolved_at = NOW(),
          resolved_by = 'cortana',
          updated_at = NOW()
      WHERE id = fb_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cortana_task_feedback_remediation_sync ON cortana_tasks;
CREATE TRIGGER cortana_task_feedback_remediation_sync
AFTER UPDATE OF status ON cortana_tasks
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION sync_feedback_remediation_from_task();
`;

  const syncSql = `
WITH linked AS (
  SELECT id, status, metadata->>'feedback_id' AS feedback_id
  FROM cortana_tasks
  WHERE metadata ? 'feedback_id'
),
inprog AS (
  UPDATE mc_feedback_items f
  SET remediation_status = 'in_progress', updated_at = NOW()
  FROM linked l
  WHERE l.status = 'in_progress'
    AND l.feedback_id ~* '^[0-9a-f-]{36}$'
    AND f.id = l.feedback_id::uuid
  RETURNING f.id
),
resolved AS (
  UPDATE mc_feedback_items f
  SET remediation_status = 'resolved',
      resolved_at = COALESCE(f.resolved_at, NOW()),
      resolved_by = COALESCE(f.resolved_by, 'cortana'),
      updated_at = NOW()
  FROM linked l
  WHERE l.status = 'completed'
    AND l.feedback_id ~* '^[0-9a-f-]{36}$'
    AND f.id = l.feedback_id::uuid
  RETURNING f.id
)
SELECT
  (SELECT COUNT(*) FROM inprog) AS set_in_progress,
  (SELECT COUNT(*) FROM resolved) AS set_resolved;
`;

  switch (mode) {
    case "--install": {
      const code = run(db, installSql);
      if (code !== 0) process.exit(code);
      console.log("Installed cortana_tasks -> mc_feedback_items remediation trigger");
      return;
    }
    case "--sync-now": {
      const code = run(db, syncSql);
      process.exit(code);
    }
    case "--install-and-sync": {
      let code = run(db, installSql);
      if (code !== 0) process.exit(code);
      code = run(db, syncSql);
      process.exit(code);
    }
    default:
      console.log(`Usage: ${process.argv[1] ?? "sync-remediation.ts"} [--install|--sync-now|--install-and-sync]`);
      process.exit(1);
  }
}

main();
