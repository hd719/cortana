#!/usr/bin/env npx tsx

/** Publish sub-agent lifecycle events to Cortana event bus. */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "../lib/db.js";
import { resolveRepoPath } from "../lib/paths.js";

const DEFAULT_DB = "cortana";
const EVENT_SOURCE = "agent_lifecycle";
const TRACE_CLI = path.join(resolveRepoPath(), "tools", "covenant", "trace.ts");

class LifecycleEventError extends Error {}

type Json = Record<string, any>;

type BaseArgs = {
  agentRole: string;
  taskId: number;
  chainId: string;
  traceId?: string;
  label: string;
};

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function runPsqlQuery(db: string, sql: string): string {
  const result = runPsql(sql, { db, args: ["-X", "-q", "-At"], env: withPostgresPath(process.env) });
  if (result.status !== 0) {
    const err = (result.stderr || "").toString().trim();
    throw new LifecycleEventError(err || "psql command failed");
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
  agentRole: string,
  taskId: number,
  chainId: string,
  startedAt: string,
  metadata?: Json
): void {
  if (!traceId || !fs.existsSync(TRACE_CLI)) return;

  const meta = metadata ?? {};
  const cmd = [
    TRACE_CLI,
    "--db",
    db,
    "log",
    traceId,
    spanName,
    "--agent",
    agentRole,
    "--task",
    String(taskId),
    "--chain-id",
    chainId,
    "--start",
    startedAt,
    "--end",
    nowIso(),
    "--metadata",
    JSON.stringify(meta),
  ];

  spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
}

function publishEvent(db: string, eventType: string, payload: Json): number {
  const payloadJson = JSON.stringify(payload);
  const sql =
    "SELECT cortana_event_bus_publish(" +
    `'${sqlQuote(eventType)}', ` +
    `'${EVENT_SOURCE}', ` +
    `'${sqlQuote(payloadJson)}'::jsonb, ` +
    "NULL" +
    ");";
  const out = runPsqlQuery(db, sql);
  const parsed = Number.parseInt(out, 10);
  if (!Number.isFinite(parsed)) {
    throw new LifecycleEventError(`Unexpected publish result: ${JSON.stringify(out)}`);
  }
  return parsed;
}

function publishSpawn(
  agentRole: string,
  taskId: number,
  chainId: string,
  label: string,
  model: string,
  traceId: string | undefined,
  db: string
): number {
  return publishEvent(db, "agent_spawned", {
    agent_role: agentRole,
    task_id: taskId,
    chain_id: chainId,
    trace_id: traceId,
    label,
    model,
  });
}

function publishCompletion(
  agentRole: string,
  taskId: number,
  chainId: string,
  label: string,
  durationMs: number,
  outcomeSummary: string,
  traceId: string | undefined,
  db: string
): number {
  return publishEvent(db, "agent_completed", {
    agent_role: agentRole,
    task_id: taskId,
    chain_id: chainId,
    trace_id: traceId,
    label,
    duration_ms: durationMs,
    outcome_summary: outcomeSummary,
  });
}

function publishFailure(
  agentRole: string,
  taskId: number,
  chainId: string,
  label: string,
  error: string,
  durationMs: number,
  traceId: string | undefined,
  db: string
): number {
  return publishEvent(db, "agent_failed", {
    agent_role: agentRole,
    task_id: taskId,
    chain_id: chainId,
    trace_id: traceId,
    label,
    error,
    duration_ms: durationMs,
  });
}

function publishTimeout(
  agentRole: string,
  taskId: number,
  chainId: string,
  label: string,
  timeoutSeconds: number,
  traceId: string | undefined,
  db: string
): number {
  return publishEvent(db, "agent_timeout", {
    agent_role: agentRole,
    task_id: taskId,
    chain_id: chainId,
    trace_id: traceId,
    label,
    timeout_seconds: timeoutSeconds,
  });
}

function usageError(): never {
  console.error("usage: lifecycle_events.py [--db <db>] {spawn|complete|fail|timeout} <args>");
  process.exit(2);
}

function parseBaseArgs(args: string[]): BaseArgs {
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx >= 0) return args[idx + 1];
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    return undefined;
  };

  const agentRole = get("--agent-role");
  const taskIdRaw = get("--task-id");
  const chainId = get("--chain-id");
  const label = get("--label");
  const traceId = get("--trace-id");

  if (!agentRole || !taskIdRaw || !chainId || !label) usageError();

  return {
    agentRole,
    taskId: Number(taskIdRaw),
    chainId,
    traceId,
    label,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let db = DEFAULT_DB;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--db" && argv[i + 1]) {
      db = argv[i + 1];
      argv.splice(i, 2);
      i -= 1;
      continue;
    }
    if (argv[i].startsWith("--db=")) {
      db = argv[i].slice("--db=".length);
      argv.splice(i, 1);
      i -= 1;
    }
  }

  const command = argv.shift();
  if (!command) usageError();

  try {
    const startedAt = nowIso();

    if (command === "spawn") {
      const base = parseBaseArgs(argv);
      const model = (() => {
        const idx = argv.indexOf("--model");
        if (idx >= 0) return argv[idx + 1];
        const eq = argv.find((a) => a.startsWith("--model="));
        if (eq) return eq.slice("--model=".length);
        return undefined;
      })();
      if (!model) usageError();

      const eventId = publishSpawn(base.agentRole, base.taskId, base.chainId, base.label, model, base.traceId, db);
      logTraceSpan(db, base.traceId, "agent_spawn", base.agentRole, base.taskId, base.chainId, startedAt, {
        label: base.label,
        model,
      });
      console.log(JSON.stringify({ ok: true, event_id: eventId, event_type: "agent_spawned", trace_id: base.traceId }));
      return;
    }

    if (command === "complete") {
      const base = parseBaseArgs(argv);
      const durationMsRaw = (() => {
        const idx = argv.indexOf("--duration-ms");
        if (idx >= 0) return argv[idx + 1];
        const eq = argv.find((a) => a.startsWith("--duration-ms="));
        if (eq) return eq.slice("--duration-ms=".length);
        return undefined;
      })();
      const outcomeSummary = (() => {
        const idx = argv.indexOf("--outcome-summary");
        if (idx >= 0) return argv[idx + 1];
        const eq = argv.find((a) => a.startsWith("--outcome-summary="));
        if (eq) return eq.slice("--outcome-summary=".length);
        return undefined;
      })();
      if (!durationMsRaw || !outcomeSummary) usageError();
      const durationMs = Number(durationMsRaw);

      const eventId = publishCompletion(
        base.agentRole,
        base.taskId,
        base.chainId,
        base.label,
        durationMs,
        outcomeSummary,
        base.traceId,
        db
      );
      logTraceSpan(db, base.traceId, "agent_complete", base.agentRole, base.taskId, base.chainId, startedAt, {
        label: base.label,
        outcome_summary: outcomeSummary,
      });
      console.log(JSON.stringify({ ok: true, event_id: eventId, event_type: "agent_completed", trace_id: base.traceId }));
      return;
    }

    if (command === "fail") {
      const base = parseBaseArgs(argv);
      const errorText = (() => {
        const idx = argv.indexOf("--error");
        if (idx >= 0) return argv[idx + 1];
        const eq = argv.find((a) => a.startsWith("--error="));
        if (eq) return eq.slice("--error=".length);
        return undefined;
      })();
      const durationMsRaw = (() => {
        const idx = argv.indexOf("--duration-ms");
        if (idx >= 0) return argv[idx + 1];
        const eq = argv.find((a) => a.startsWith("--duration-ms="));
        if (eq) return eq.slice("--duration-ms=".length);
        return undefined;
      })();
      if (!errorText || !durationMsRaw) usageError();
      const durationMs = Number(durationMsRaw);

      const eventId = publishFailure(
        base.agentRole,
        base.taskId,
        base.chainId,
        base.label,
        errorText,
        durationMs,
        base.traceId,
        db
      );
      logTraceSpan(db, base.traceId, "agent_fail", base.agentRole, base.taskId, base.chainId, startedAt, {
        label: base.label,
        error: errorText,
      });
      console.log(JSON.stringify({ ok: true, event_id: eventId, event_type: "agent_failed", trace_id: base.traceId }));
      return;
    }

    if (command === "timeout") {
      const base = parseBaseArgs(argv);
      const timeoutRaw = (() => {
        const idx = argv.indexOf("--timeout-seconds");
        if (idx >= 0) return argv[idx + 1];
        const eq = argv.find((a) => a.startsWith("--timeout-seconds="));
        if (eq) return eq.slice("--timeout-seconds=".length);
        return undefined;
      })();
      if (!timeoutRaw) usageError();
      const timeoutSeconds = Number(timeoutRaw);

      const eventId = publishTimeout(
        base.agentRole,
        base.taskId,
        base.chainId,
        base.label,
        timeoutSeconds,
        base.traceId,
        db
      );
      logTraceSpan(db, base.traceId, "agent_timeout", base.agentRole, base.taskId, base.chainId, startedAt, {
        label: base.label,
        timeout_seconds: timeoutSeconds,
      });
      console.log(JSON.stringify({ ok: true, event_id: eventId, event_type: "agent_timeout", trace_id: base.traceId }));
      return;
    }

    throw new LifecycleEventError(`Unsupported command: ${command}`);
  } catch (err) {
    if (err instanceof LifecycleEventError) {
      console.error(`LIFECYCLE_EVENT_ERROR: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
