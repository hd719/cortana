#!/usr/bin/env npx tsx
import { randomUUID } from "crypto";
import { runPsql, withPostgresPath } from "../lib/db.js";
import { PSQL_BIN } from "../lib/paths.js";

const DB_NAME = process.env.CORTANA_DB ?? "cortana";
const SOURCE = process.env.ALERT_INTENT_SOURCE ?? "alert-intent-emitter";

const ALERT_TYPE = process.argv[2] ?? process.env.ALERT_TYPE ?? "generic";
const TARGET_CHANNEL = process.argv[3] ?? process.env.TARGET_CHANNEL ?? "telegram";
let EXPECTED_DELIVERY_TIME = process.argv[4] ?? process.env.EXPECTED_DELIVERY_TIME ?? "";
let INTENT_ID = process.argv[5] ?? process.env.ALERT_INTENT_ID ?? "";

function usage(): void {
  console.error(
    `Usage: emit-alert-intent.ts <alert_type> [target_channel] [expected_delivery_time_iso8601] [intent_id]`
  );
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

if (!ALERT_TYPE) {
  usage();
  process.exit(1);
}

const psqlCheck = runPsql("SELECT 1;", {
  db: DB_NAME,
  args: ["-q", "-X", "-v", "ON_ERROR_STOP=1"],
  env: withPostgresPath(process.env),
});

if (psqlCheck.error || psqlCheck.status !== 0) {
  console.error(`psql not found at ${PSQL_BIN}`);
  process.exit(1);
}

if (!INTENT_ID) {
  INTENT_ID = randomUUID().toLowerCase();
}

if (!EXPECTED_DELIVERY_TIME) {
  const expectedSeconds = Number(process.env.ALERT_EXPECTED_DELIVERY_SECONDS ?? "120");
  EXPECTED_DELIVERY_TIME = new Date(Date.now() + expectedSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const escMsg = sqlEscape(
  `Alert intent registered: type=${ALERT_TYPE}, intent_id=${INTENT_ID}, target=${TARGET_CHANNEL}`
);
const escMeta = sqlEscape(
  JSON.stringify({
    intent_id: INTENT_ID,
    alert_type: ALERT_TYPE,
    target_channel: TARGET_CHANNEL,
    expected_delivery_time: EXPECTED_DELIVERY_TIME,
  })
);

const insert = runPsql(
  `
  INSERT INTO cortana_events (event_type, source, severity, message, metadata)
  VALUES (
    'alert_intent',
    '${sqlEscape(SOURCE)}',
    'info',
    '${escMsg}',
    '${escMeta}'::jsonb
  );
`,
  {
    db: DB_NAME,
    args: ["-q", "-X", "-v", "ON_ERROR_STOP=1"],
    env: withPostgresPath(process.env),
    stdio: ["ignore", "ignore", "pipe"],
  }
);

if (insert.status !== 0) {
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    intent_id: INTENT_ID,
    alert_type: ALERT_TYPE,
    target_channel: TARGET_CHANNEL,
    expected_delivery_time: EXPECTED_DELIVERY_TIME,
  })}\n`
);
