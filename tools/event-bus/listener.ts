#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runPsql } from "../lib/db.js";

const DEFAULT_EVENT_TYPES = [
  "email_received",
  "task_created",
  "calendar_approaching",
  "portfolio_alert",
  "health_update",
];

type Args = {
  db: string;
  eventTypes: string[];
  pollSeconds: number;
  fromId: number | null;
  fromBeginning: boolean;
  logFile: string;
  markDelivered: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: "cortana",
    eventTypes: [...DEFAULT_EVENT_TYPES],
    pollSeconds: 1.0,
    fromId: null,
    fromBeginning: false,
    logFile: path.join(os.homedir(), "clawd", "tmp", "event-bus-listener.log"),
    markDelivered: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--db") {
      args.db = argv[++i] ?? args.db;
    } else if (a === "--event-types") {
      const vals: string[] = [];
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith("--")) {
        vals.push(argv[j]);
        j += 1;
      }
      if (vals.length) args.eventTypes = vals;
      i = j - 1;
    } else if (a === "--poll-seconds") {
      args.pollSeconds = Number.parseFloat(argv[++i] ?? "1");
    } else if (a === "--from-id") {
      const raw = argv[++i];
      args.fromId = raw ? Number.parseInt(raw, 10) : null;
    } else if (a === "--from-beginning") {
      args.fromBeginning = true;
    } else if (a === "--log-file") {
      args.logFile = argv[++i] ?? args.logFile;
    } else if (a === "--mark-delivered") {
      args.markDelivered = true;
    }
  }

  return args;
}

function appendJsonl(filePath: string, obj: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, "utf8");
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function runPsqlText(db: string, sql: string): string {
  const proc = runPsql(sql, {
    db,
    args: ["-X", "-q", "-At"],
    stdio: "pipe",
  });
  if (proc.status !== 0) {
    throw new Error((proc.stderr || "").trim() || "psql failed");
  }
  return (proc.stdout || "").trim();
}

function initialCursor(args: Args): number {
  if (args.fromBeginning) return 0;
  if (args.fromId !== null && !Number.isNaN(args.fromId)) return args.fromId;
  const out = runPsqlText(args.db, "SELECT COALESCE(MAX(id), 0) FROM cortana_event_bus_events;");
  return Number.parseInt(out || "0", 10);
}

function fetchNewEvents(db: string, lastId: number, eventTypes: string[]): Array<Record<string, any>> {
  const quoted = eventTypes.map((t) => `'${sqlEscape(t)}'`).join(",");
  const sql = `
        SELECT jsonb_build_object(
            'id', id,
            'created_at', created_at,
            'event_type', event_type,
            'source', source,
            'payload', payload,
            'correlation_id', correlation_id,
            'delivered', delivered
        )::text
        FROM cortana_event_bus_events
        WHERE id > ${lastId}
          AND event_type IN (${quoted})
        ORDER BY id ASC;
    `;
  const out = runPsqlText(db, sql);
  if (!out) return [];
  const events: Array<Record<string, any>> = [];
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    events.push(JSON.parse(trimmed));
  }
  return events;
}

function markDelivered(db: string, eventId: number): void {
  const sql = `SELECT cortana_event_bus_mark_delivered(${eventId});`;
  const proc = runPsql(sql, { db, args: ["-X", "-q", "-At"], stdio: "pipe" });
  if (proc.status !== 0) {
    const msg = (proc.stderr || "").trim();
    console.error(`WARN mark_delivered failed for event ${eventId}: ${msg}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const lastIdStart = initialCursor(args);
  let lastId = lastIdStart;

  const startup = {
    ts: nowIso(),
    type: "listener_started",
    db: args.db,
    last_id: lastId,
    event_types: args.eventTypes,
    poll_seconds: args.pollSeconds,
  };
  appendJsonl(args.logFile, startup);
  console.log(JSON.stringify(startup));

  let interrupted = false;
  process.on("SIGINT", () => {
    interrupted = true;
  });

  try {
    while (!interrupted) {
      const events = fetchNewEvents(args.db, lastId, args.eventTypes);
      for (const event of events) {
        const envelope = {
          ts: nowIso(),
          channel: `cortana_${event.event_type}`,
          envelope: event,
        };
        appendJsonl(args.logFile, envelope);
        console.log(JSON.stringify(envelope));
        lastId = Math.max(lastId, Number.parseInt(String(event.id), 10));
        if (args.markDelivered) {
          markDelivered(args.db, Number.parseInt(String(event.id), 10));
        }
      }
      await sleep(Math.max(0, args.pollSeconds) * 1000);
    }
  } finally {
    if (interrupted) {
      const shutdown = { ts: nowIso(), type: "listener_stopped", last_id: lastId };
      appendJsonl(args.logFile, shutdown);
      console.log(JSON.stringify(shutdown));
    }
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
