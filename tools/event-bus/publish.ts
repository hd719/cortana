#!/usr/bin/env npx tsx

import fs from "node:fs";
import { runPsql } from "../lib/db.js";

const ALLOWED_EVENT_TYPES = new Set([
  "calendar_approaching",
  "email_received",
  "health_update",
  "portfolio_alert",
  "task_created",
]);

type Args = {
  eventType: string;
  db: string;
  source: string;
  payload: string;
  payloadFile: string | null;
  correlationId: string | null;
};

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function parseArgs(argv: string[]): Args {
  if (!argv.length) {
    throw new Error("event_type is required");
  }

  const args: Args = {
    eventType: argv[0],
    db: "cortana",
    source: "manual",
    payload: "{}",
    payloadFile: null,
    correlationId: null,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--db") {
      args.db = argv[++i] ?? args.db;
    } else if (a === "--source") {
      args.source = argv[++i] ?? args.source;
    } else if (a === "--payload") {
      args.payload = argv[++i] ?? args.payload;
    } else if (a === "--payload-file") {
      args.payloadFile = argv[++i] ?? null;
    } else if (a === "--correlation-id") {
      args.correlationId = argv[++i] ?? null;
    }
  }

  return args;
}

function loadPayload(args: Args): Record<string, unknown> {
  if (args.payloadFile) {
    const raw = fs.readFileSync(args.payloadFile, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  }
  return JSON.parse(args.payload) as Record<string, unknown>;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    return 2;
  }

  if (!ALLOWED_EVENT_TYPES.has(args.eventType)) {
    console.error(`Invalid event_type: ${args.eventType}`);
    return 2;
  }

  let payloadObj: Record<string, unknown>;
  try {
    payloadObj = loadPayload(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Invalid JSON payload: ${msg}`);
    return 2;
  }

  const payloadJson = JSON.stringify(payloadObj);
  const sourceSql = sqlQuote(args.source);
  const payloadSql = sqlQuote(payloadJson);

  let corrSql = "NULL";
  if (args.correlationId) {
    corrSql = `'${sqlQuote(args.correlationId)}'::uuid`;
  }

  const sql =
    "SELECT cortana_event_bus_publish(" +
    `'${args.eventType}', ` +
    `'${sourceSql}', ` +
    `'${payloadSql}'::jsonb, ` +
    `${corrSql}` +
    ");";

  const proc = runPsql(sql, {
    db: args.db,
    args: ["-X", "-q", "-At"],
    stdio: "pipe",
  });

  if (proc.status !== 0) {
    const errMsg = (proc.stderr || "").trim() || "publish failed";
    console.error(errMsg);
    return proc.status ?? 1;
  }

  const eventIdStr = (proc.stdout || "").trim();
  const eventId = Number.parseInt(eventIdStr, 10);
  console.log(JSON.stringify({ ok: true, event_id: eventId, event_type: args.eventType }));
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
