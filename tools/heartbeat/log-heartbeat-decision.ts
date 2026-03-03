#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";

function esc(v: string): string {
  return v.replace(/'/g, "''");
}

const [
  checkName = "unknown_check",
  status = "info",
  summary = "",
  details = "{}",
] = process.argv.slice(2);

const allowedStatus = new Set(["ok", "warning", "error", "info"]);
const st = allowedStatus.has(status) ? status : "info";

let detailsJson = details;
try {
  JSON.parse(detailsJson);
} catch {
  detailsJson = JSON.stringify({ raw: details });
}

const db = process.env.CORTANA_DB || "cortana";
const sql = `
INSERT INTO cortana_events (event_type, source, severity, message, metadata)
VALUES (
  'heartbeat_decision',
  'heartbeat',
  '${esc(st)}',
  '${esc(summary)}',
  jsonb_build_object(
    'check_name', '${esc(checkName)}',
    'status', '${esc(st)}',
    'details', '${esc(detailsJson)}'::jsonb
  )
);
`;

const psqlBin = process.env.PSQL_BIN || "/opt/homebrew/opt/postgresql@17/bin/psql";
const env = {
  ...process.env,
  PATH: `/opt/homebrew/opt/postgresql@17/bin:${process.env.PATH || ""}`,
};

const res = spawnSync(psqlBin, [db, "-v", "ON_ERROR_STOP=1", "-c", sql], {
  encoding: "utf8",
  env,
});

if (res.status !== 0) {
  const err = (res.stderr || res.stdout || "psql failed").trim();
  console.error(`[log-heartbeat-decision] ${err}`);
  process.exit(1);
}

console.log("ok");
