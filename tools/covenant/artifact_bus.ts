#!/usr/bin/env npx tsx

/** Handoff Artifact Bus (HAB) CLI for Cortana-controlled inter-agent context relay. */

import fs from "fs";
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "../lib/db.js";
import { resolveRepoPath } from "../lib/paths.js";

const DEFAULT_DB = "cortana";
const DEFAULT_CREATED_BY = "cortana";
const ALLOWED_CREATED_BY = new Set(["cortana"]);
const TRACE_CLI = resolveRepoPath("tools", "covenant", "trace.py");

class HabError extends Error {}
class UsageError extends Error {}

type Json = Record<string, unknown>;

type ArgsBase = {
  db: string;
  command: string;
};

type WriteArgs = ArgsBase & {
  chainId: string;
  fromAgent: string;
  toAgent?: string;
  artifactType: string;
  payload?: string;
  payloadFile?: string;
  createdBy: string;
  traceId?: string;
};

type ReadArgs = ArgsBase & { chainId: string; toAgent?: string; includeConsumed: boolean };

type ConsumeArgs = ArgsBase & { chainId: string; toAgent?: string; ids: string[]; traceId?: string };

type ListArgs = ArgsBase & { chainId: string };

type CleanupArgs = ArgsBase & { days: number };

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function runPsqlQuery(db: string, sql: string): string {
  const result = runPsql(sql, {
    db,
    args: ["-X", "-q", "-At"],
    env: withPostgresPath(process.env),
  });
  if (result.status !== 0) {
    const err = (result.stderr || "").toString().trim();
    throw new HabError(err || "psql command failed");
  }
  return (result.stdout || "").toString().trim();
}

function nowIso(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}

function logTraceSpan(
  db: string,
  traceId: string | undefined,
  spanName: string,
  fromAgent: string,
  chainId: string,
  metadata: Json | null = null
): void {
  if (!traceId) return;
  if (!fs.existsSync(TRACE_CLI)) return;

  const cmd = [
    "python3",
    TRACE_CLI,
    "--db",
    db,
    "log",
    traceId,
    spanName,
    "--agent",
    fromAgent,
    "--chain-id",
    chainId,
    "--start",
    nowIso(),
    "--end",
    nowIso(),
    "--metadata",
    JSON.stringify(metadata ?? {}, null, 0),
  ];
  spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
}

function publishEvent(db: string, eventType: string, payload: Json): void {
  const payloadJson = JSON.stringify(payload);
  const sql =
    "SELECT cortana_event_bus_publish(" +
    `'${sqlQuote(eventType)}', ` +
    "'artifact_bus', " +
    `'${sqlQuote(payloadJson)}'::jsonb, ` +
    "NULL" +
    ");";
  runPsqlQuery(db, sql);
}

function parsePayload(payload: string | undefined, payloadFile: string | undefined): Json {
  if (payload && payloadFile) {
    throw new HabError("Use only one of --payload or --payload-file");
  }
  if (payloadFile) {
    const raw = fs.readFileSync(payloadFile, "utf8");
    return JSON.parse(raw) as Json;
  }
  if (payload) {
    return JSON.parse(payload) as Json;
  }
  throw new HabError("Payload is required (--payload or --payload-file)");
}

function cmdWrite(args: WriteArgs): number {
  const createdBy = args.createdBy || DEFAULT_CREATED_BY;
  if (!ALLOWED_CREATED_BY.has(createdBy)) {
    throw new HabError("created_by must be 'cortana'");
  }

  const payloadObj = parsePayload(args.payload, args.payloadFile);
  const payloadJson = JSON.stringify(payloadObj);

  let toAgentSql = "NULL";
  if (args.toAgent) {
    toAgentSql = `'${sqlQuote(args.toAgent)}'`;
  }

  const sql =
    "WITH ins AS (" +
    "INSERT INTO cortana_handoff_artifacts " +
    "(chain_id, from_agent, to_agent, artifact_type, payload, created_by) " +
    "VALUES (" +
    `'${sqlQuote(args.chainId)}'::uuid, ` +
    `'${sqlQuote(args.fromAgent)}', ` +
    `${toAgentSql}, ` +
    `'${sqlQuote(args.artifactType)}', ` +
    `'${sqlQuote(payloadJson)}'::jsonb, ` +
    `'${sqlQuote(createdBy)}'` +
    ") RETURNING id, chain_id, from_agent, to_agent, artifact_type, created_by, created_at" +
    ") SELECT row_to_json(ins)::text FROM ins;";

  const out = runPsqlQuery(args.db, sql);
  const row = out ? (JSON.parse(out) as Json) : {};

  publishEvent(args.db, "artifact_created", {
    artifact_id: row.id,
    chain_id: row.chain_id,
    trace_id: args.traceId,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    artifact_type: row.artifact_type,
    created_by: row.created_by,
  });

  logTraceSpan(args.db, args.traceId, "artifact_write", args.fromAgent, args.chainId, {
    artifact_id: row.id,
    to_agent: row.to_agent,
    artifact_type: row.artifact_type,
  });

  console.log(JSON.stringify({ ok: true, artifact: row, trace_id: args.traceId }));
  return 0;
}

function cmdRead(args: ReadArgs): number {
  const filters = [`chain_id = '${sqlQuote(args.chainId)}'::uuid`];

  if (args.toAgent) {
    filters.push(`(to_agent IS NULL OR to_agent = '${sqlQuote(args.toAgent)}')`);
  }

  if (!args.includeConsumed) {
    filters.push("consumed_at IS NULL");
  }

  const whereSql = filters.join(" AND ");

  const sql =
    "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.created_at ASC), '[]'::json)::text " +
    "FROM (" +
    "SELECT id, chain_id, from_agent, to_agent, artifact_type, payload, created_by, consumed_at, created_at " +
    "FROM cortana_handoff_artifacts " +
    `WHERE ${whereSql} ` +
    "ORDER BY created_at ASC" +
    ") t;";

  const out = runPsqlQuery(args.db, sql);
  const artifacts = JSON.parse(out || "[]");
  console.log(JSON.stringify({ ok: true, artifacts }));
  return 0;
}

function cmdList(args: ListArgs): number {
  const sql =
    "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.created_at ASC), '[]'::json)::text " +
    "FROM (" +
    "SELECT id, chain_id, from_agent, to_agent, artifact_type, created_by, consumed_at, created_at, " +
    "CASE WHEN consumed_at IS NULL THEN 'unconsumed' ELSE 'consumed' END AS status " +
    "FROM cortana_handoff_artifacts " +
    `WHERE chain_id = '${sqlQuote(args.chainId)}'::uuid ` +
    "ORDER BY created_at ASC" +
    ") t;";

  const out = runPsqlQuery(args.db, sql);
  const artifacts = JSON.parse(out || "[]");
  console.log(JSON.stringify({ ok: true, artifacts }));
  return 0;
}

function cmdConsume(args: ConsumeArgs): number {
  const filters = [`chain_id = '${sqlQuote(args.chainId)}'::uuid`, "consumed_at IS NULL"];

  if (args.toAgent) {
    filters.push(`(to_agent IS NULL OR to_agent = '${sqlQuote(args.toAgent)}')`);
  }

  if (args.ids.length) {
    const idList = args.ids
      .map((x) => {
        const parsed = Number.parseInt(String(x), 10);
        if (Number.isNaN(parsed)) {
          throw new Error(`invalid literal for int() with base 10: '${x}'`);
        }
        return String(parsed);
      })
      .join(",");
    filters.push(`id IN (${idList})`);
  }

  const whereSql = filters.join(" AND ");

  const sql =
    "WITH upd AS (" +
    "UPDATE cortana_handoff_artifacts " +
    "SET consumed_at = NOW() " +
    `WHERE ${whereSql} ` +
    "RETURNING id, chain_id, from_agent, to_agent, artifact_type, consumed_at" +
    ") SELECT COALESCE(json_agg(row_to_json(upd)), '[]'::json)::text FROM upd;";

  const out = runPsqlQuery(args.db, sql);
  const consumed = JSON.parse(out || "[]") as Array<Json>;

  for (const item of consumed) {
    publishEvent(args.db, "artifact_consumed", {
      artifact_id: item.id,
      chain_id: item.chain_id,
      trace_id: args.traceId,
      from_agent: item.from_agent,
      to_agent: item.to_agent,
      artifact_type: item.artifact_type,
      consumed_at: item.consumed_at,
    });

    logTraceSpan(
      args.db,
      args.traceId,
      "artifact_consume",
      String(item.from_agent ?? "unknown"),
      args.chainId,
      {
        artifact_id: item.id,
        to_agent: item.to_agent,
        artifact_type: item.artifact_type,
        consumed_at: item.consumed_at,
      }
    );
  }

  console.log(JSON.stringify({ ok: true, consumed, count: consumed.length, trace_id: args.traceId }));
  return 0;
}

function cmdCleanup(args: CleanupArgs): number {
  const sql =
    "WITH del AS (" +
    "DELETE FROM cortana_handoff_artifacts " +
    `WHERE created_at < NOW() - INTERVAL '${Number(args.days)} days' ` +
    "RETURNING id" +
    ") SELECT COUNT(*)::text FROM del;";
  const out = runPsqlQuery(args.db, sql);
  console.log(JSON.stringify({ ok: true, deleted: Number(out || 0), older_than_days: Number(args.days) }));
  return 0;
}

function usageError(message: string): never {
  throw new UsageError(message);
}

function parseArgs(argv: string[]): ArgsBase & Record<string, unknown> {
  const args = [...argv];
  let db = DEFAULT_DB;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--db" && args[i + 1]) {
      db = args[i + 1];
      args.splice(i, 2);
      i -= 1;
      continue;
    }
    if (arg.startsWith("--db=")) {
      db = arg.slice("--db=".length);
      args.splice(i, 1);
      i -= 1;
    }
  }

  const commands = new Set(["write", "read", "consume", "list", "cleanup"]);
  const commandIndex = args.findIndex((a) => commands.has(a));
  if (commandIndex === -1) {
    usageError("Missing command (write|read|consume|list|cleanup)");
  }

  const command = args[commandIndex];
  const rest = args.slice(commandIndex + 1);

  const getValue = (flag: string): string | undefined => {
    const eqPrefix = `${flag}=`;
    for (let i = 0; i < rest.length; i += 1) {
      const item = rest[i];
      if (item === flag) return rest[i + 1];
      if (item.startsWith(eqPrefix)) return item.slice(eqPrefix.length);
    }
    return undefined;
  };

  const hasFlag = (flag: string): boolean => rest.includes(flag);

  if (command === "write") {
    return {
      db,
      command,
      chainId: getValue("--chain-id") ?? "",
      fromAgent: getValue("--from-agent") ?? "",
      toAgent: getValue("--to-agent"),
      artifactType: getValue("--artifact-type") ?? "",
      payload: getValue("--payload"),
      payloadFile: getValue("--payload-file"),
      createdBy: getValue("--created-by") ?? DEFAULT_CREATED_BY,
      traceId: getValue("--trace-id"),
    } as WriteArgs;
  }

  if (command === "read") {
    return {
      db,
      command,
      chainId: getValue("--chain-id") ?? "",
      toAgent: getValue("--to-agent"),
      includeConsumed: hasFlag("--include-consumed"),
    } as ReadArgs;
  }

  if (command === "consume") {
    const ids: string[] = [];
    const idsIndex = rest.indexOf("--ids");
    if (idsIndex !== -1) {
      for (let i = idsIndex + 1; i < rest.length; i += 1) {
        const value = rest[i];
        if (value.startsWith("--")) break;
        ids.push(value);
      }
    }
    return {
      db,
      command,
      chainId: getValue("--chain-id") ?? "",
      toAgent: getValue("--to-agent"),
      ids,
      traceId: getValue("--trace-id"),
    } as ConsumeArgs;
  }

  if (command === "list") {
    return {
      db,
      command,
      chainId: getValue("--chain-id") ?? "",
    } as ListArgs;
  }

  if (command === "cleanup") {
    return {
      db,
      command,
      days: Number.parseInt(getValue("--days") ?? "", 10),
    } as CleanupArgs;
  }

  usageError(`Unknown command: ${command}`);
}

function validateWriteArgs(args: WriteArgs): void {
  if (!args.chainId) usageError("--chain-id is required");
  if (!args.fromAgent) usageError("--from-agent is required");
  if (!args.artifactType) usageError("--artifact-type is required");
}

function validateReadArgs(args: ReadArgs): void {
  if (!args.chainId) usageError("--chain-id is required");
}

function validateConsumeArgs(args: ConsumeArgs): void {
  if (!args.chainId) usageError("--chain-id is required");
}

function validateListArgs(args: ListArgs): void {
  if (!args.chainId) usageError("--chain-id is required");
}

function validateCleanupArgs(args: CleanupArgs): void {
  if (!Number.isInteger(args.days)) usageError("--days is required");
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    let code = 0;
    switch (args.command) {
      case "write":
        validateWriteArgs(args as WriteArgs);
        code = cmdWrite(args as WriteArgs);
        break;
      case "read":
        validateReadArgs(args as ReadArgs);
        code = cmdRead(args as ReadArgs);
        break;
      case "consume":
        validateConsumeArgs(args as ConsumeArgs);
        code = cmdConsume(args as ConsumeArgs);
        break;
      case "list":
        validateListArgs(args as ListArgs);
        code = cmdList(args as ListArgs);
        break;
      case "cleanup":
        validateCleanupArgs(args as CleanupArgs);
        code = cmdCleanup(args as CleanupArgs);
        break;
      default:
        usageError(`Unknown command: ${args.command}`);
    }
    process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      process.exit(2);
    }
    if (err instanceof HabError) {
      console.error(`HAB_ERROR: ${err.message}`);
      process.exit(1);
    }
    if (err instanceof SyntaxError) {
      console.error(`HAB_ERROR: invalid JSON payload: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

main();
