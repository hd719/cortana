#!/usr/bin/env npx tsx

import { spawnSync } from "child_process";
import { withPostgresPath } from "../lib/db.js";
import { PSQL_BIN } from "../lib/paths.js";

const args = process.argv.slice(2);

if (args.length < 3) {
  console.error(
    `Usage: ${process.argv[1] ?? "add-feedback-action.ts"} <feedback_id> <action_type> <description> [action_ref] [status]`
  );
  process.exit(1);
}

const [feedbackId, actionType, description, actionRefRaw, statusRaw] = args;
const actionRef = actionRefRaw ?? "";
const status = statusRaw !== undefined && statusRaw !== "" ? statusRaw : "planned";

const isUuid = (value: string) =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    value
  );

if (!isUuid(feedbackId ?? "")) {
  console.error("Error: feedback_id must be a UUID");
  process.exit(1);
}

const escapeSql = (value: string) => value.replace(/'/g, "''");

const safeActionType = escapeSql(actionType ?? "");
const safeDescription = escapeSql(description ?? "");
const safeActionRef = escapeSql(actionRef);
const actionRefSql = actionRef ? `'${safeActionRef}'` : "NULL";

const sql = `
INSERT INTO mc_feedback_actions (feedback_id, action_type, action_ref, description, status)
VALUES (
  '${feedbackId}'::uuid,
  '${safeActionType}',
  ${actionRefSql},
  '${safeDescription}',
  '${status}'
);
`;

const result = spawnSync(PSQL_BIN, ["cortana", "-c", sql], {
  encoding: "utf8",
  stdio: ["ignore", "ignore", "inherit"],
  env: withPostgresPath(process.env),
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Added action '${actionType}' to feedback ${feedbackId}`);
