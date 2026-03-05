#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import db from "../lib/db.js";
const { withPostgresPath } = db;
import { PSQL_BIN } from "../lib/paths.js";

function isUuid(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error(`Usage: ${process.argv[1] ?? "add-feedback-action.ts"} <feedback_id> <action_type> <description> [action_ref] [status]`);
    process.exit(1);
  }

  const feedbackId = args[0] ?? "";
  const actionType = args[1] ?? "";
  const description = args[2] ?? "";
  const actionRef = args[3] ?? "";
  const status = args[4] ?? "planned";

  if (!isUuid(feedbackId)) {
    console.error("Error: feedback_id must be a UUID");
    process.exit(1);
  }

  const actionRefSql = actionRef.length > 0 ? `'${escapeSql(actionRef)}'` : "NULL";

  const sql = `
INSERT INTO mc_feedback_actions (feedback_id, action_type, action_ref, description, status)
VALUES (
  '${feedbackId}'::uuid,
  '${escapeSql(actionType)}',
  ${actionRefSql},
  '${escapeSql(description)}',
  '${status}'
);
`;

  const result = spawnSync(PSQL_BIN, ["cortana"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "inherit"],
    env: withPostgresPath(process.env),
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }

  console.log(`Added action '${actionType}' to feedback ${feedbackId}`);
}

main();
