#!/usr/bin/env npx tsx

/** Correlation tracing for Covenant agent lifecycle + boundary timing. */

import { randomUUID } from "crypto";
const DEFAULT_DB = "cortana";

class TraceError extends Error {}

type Json = Record<string, any>;

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function runPsqlQuery(db: string, sql: string): string {
  const result = runPsql(sql, { db, args: ["-X", "-q", "-At"], env: withPostgresPath(process.env) });
  if (result.status !== 0) {
    const err = (result.stderr || "").toString().trim();
    throw new TraceError(err || "psql command failed");
  }
  return (result.stdout || "").toString().trim();
}

function nowIso(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}

function generateTraceId(): string {
  return randomUUID();
}

function logSpan(
  traceId: string,
  spanName: string,
  agentRole?: string | null,
  taskId?: number | null,
  startedAt?: string | null,
  endedAt?: string | null,
  metadata?: Json | null,
  options?: { db?: string; chainId?: string | null; tokenCountIn?: number | null; tokenCountOut?: number | null }
): Json {
  const db = options?.db ?? DEFAULT_DB;
  const start = startedAt || nowIso();
  const end = endedAt || start;
  const meta = metadata ?? {};

  const agentSql = agentRole ? `'${sqlQuote(agentRole)}'` : "NULL";
  const taskSql = taskId == null ? "NULL" : String(Math.trunc(taskId));
  const chainSql = options?.chainId ? `'${sqlQuote(options.chainId)}'::uuid` : "NULL";
  const inSql = options?.tokenCountIn == null ? "NULL" : String(Math.trunc(options.tokenCountIn));
  const outSql = options?.tokenCountOut == null ? "NULL" : String(Math.trunc(options.tokenCountOut));
  const metadataJson = JSON.stringify(meta);

  const sql =
    "WITH ins AS (" +
    "INSERT INTO cortana_trace_spans " +
    "(trace_id, span_name, agent_role, task_id, chain_id, started_at, ended_at, token_count_in, token_count_out, metadata) " +
    "VALUES (" +
    `'${sqlQuote(traceId)}'::uuid, ` +
    `'${sqlQuote(spanName)}', ` +
    `${agentSql}, ` +
    `${taskSql}, ` +
    `${chainSql}, ` +
    `'${sqlQuote(start)}'::timestamptz, ` +
    `'${sqlQuote(end)}'::timestamptz, ` +
    `${inSql}, ` +
    `${outSql}, ` +
    `'${sqlQuote(metadataJson)}'::jsonb` +
    ") " +
    "RETURNING id, trace_id, span_name, agent_role, task_id, chain_id, started_at, ended_at, duration_ms, token_count_in, token_count_out, metadata" +
    ") SELECT row_to_json(ins)::text FROM ins;";

  const out = runPsqlQuery(db, sql);
  if (!out) throw new TraceError("failed to insert trace span");
  return JSON.parse(out);
}

function getTrace(traceId: string, db: string = DEFAULT_DB): Json[] {
  const sql =
    "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.started_at ASC, t.id ASC), '[]'::json)::text " +
    "FROM (" +
    "SELECT id, trace_id, span_name, agent_role, task_id, chain_id, started_at, ended_at, duration_ms, token_count_in, token_count_out, metadata " +
    "FROM cortana_trace_spans " +
    `WHERE trace_id = '${sqlQuote(traceId)}'::uuid ` +
    "ORDER BY started_at ASC, id ASC" +
    ") t;";
  const out = runPsqlQuery(db, sql);
  return JSON.parse(out || "[]");
}

function summary(traceId: string, db: string = DEFAULT_DB): string {
  const spans = getTrace(traceId, db);
  if (!spans.length) return `Trace ${traceId}: no spans`;

  const totalMs = spans.reduce((acc, s) => acc + Number(s.duration_ms || 0), 0);
  const totalIn = spans.reduce((acc, s) => acc + Number(s.token_count_in || 0), 0);
  const totalOut = spans.reduce((acc, s) => acc + Number(s.token_count_out || 0), 0);

  const lines = [
    `Trace ${traceId}`,
    `spans=${spans.length} total_duration_ms=${totalMs} tokens_in=${totalIn} tokens_out=${totalOut}`,
    "timeline:",
  ];

  for (const s of spans) {
    lines.push(
      `- [${s.started_at}] ${s.span_name} agent=${s.agent_role || "-"} task=${s.task_id ?? "-"} ` +
        `duration_ms=${s.duration_ms || 0} in=${s.token_count_in || 0} out=${s.token_count_out || 0}`
    );
  }

  return lines.join("\n");
}

function parseMetadata(metadataJson?: string | null): Json {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TraceError("metadata must be a JSON object");
    }
    return parsed as Json;
  } catch (err) {
    if (err instanceof TraceError) throw err;
    throw new TraceError(`invalid metadata JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function usageError(): never {
  console.error("usage: trace.py {new|log|show|recent} [args]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf("--db");
  const db = dbIdx >= 0 && args[dbIdx + 1] ? args[dbIdx + 1] : DEFAULT_DB;
  if (dbIdx >= 0) {
    args.splice(dbIdx, 2);
  }

  const command = args.shift();
  if (!command) usageError();

  try {
    if (command === "new") {
      console.log(generateTraceId());
      return;
    }

    if (command === "log") {
      const traceId = args[0];
      const spanName = args[1];
      if (!traceId || !spanName) usageError();
      const get = (flag: string): string | undefined => {
        const idx = args.indexOf(flag);
        if (idx >= 0) return args[idx + 1];
        const eq = args.find((a) => a.startsWith(`${flag}=`));
        if (eq) return eq.slice(flag.length + 1);
        return undefined;
      };
      const row = logSpan(traceId, spanName, get("--agent"), get("--task") ? Number(get("--task")) : null, get("--start"), get("--end"), parseMetadata(get("--metadata")), {
        db,
        chainId: get("--chain-id"),
        tokenCountIn: get("--tokens-in") ? Number(get("--tokens-in")) : null,
        tokenCountOut: get("--tokens-out") ? Number(get("--tokens-out")) : null,
      });
      console.log(JSON.stringify({ ok: true, span: row }));
      return;
    }

    if (command === "show") {
      const traceId = args[0];
      if (!traceId) usageError();
      const spans = getTrace(traceId, db);
      console.log(summary(traceId, db));
      console.log("\nraw:");
      console.log(JSON.stringify(spans, null, 2));
      return;
    }

    if (command === "recent") {
      const limitIdx = args.indexOf("--limit");
      const limit = limitIdx >= 0 && args[limitIdx + 1] ? Number(args[limitIdx + 1]) : 10;
      const sql =
        "WITH recent_traces AS (" +
        "SELECT trace_id, MAX(ended_at) AS last_seen " +
        "FROM cortana_trace_spans " +
        "GROUP BY trace_id " +
        "ORDER BY MAX(ended_at) DESC " +
        `LIMIT ${Math.trunc(limit)}` +
        "), agg AS (" +
        "SELECT s.trace_id, MIN(s.started_at) AS first_seen, MAX(s.ended_at) AS last_seen, " +
        "COALESCE(SUM(s.duration_ms),0)::int AS total_duration_ms, " +
        "COALESCE(SUM(s.token_count_in),0)::int AS token_in, " +
        "COALESCE(SUM(s.token_count_out),0)::int AS token_out, " +
        "COUNT(*)::int AS span_count " +
        "FROM cortana_trace_spans s " +
        "INNER JOIN recent_traces r ON r.trace_id = s.trace_id " +
        "GROUP BY s.trace_id" +
        ") " +
        "SELECT COALESCE(json_agg(row_to_json(agg) ORDER BY agg.last_seen DESC), '[]'::json)::text FROM agg;";
      const out = runPsqlQuery(db, sql);
      const rows = JSON.parse(out || "[]");
      console.log(JSON.stringify({ ok: true, traces: rows }, null, 2));
      return;
    }

    usageError();
  } catch (err) {
    if (err instanceof TraceError) {
      console.error(`TRACE_ERROR: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
