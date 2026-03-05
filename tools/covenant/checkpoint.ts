#!/usr/bin/env npx tsx

/**
 * Durable workflow checkpointing prototype for Covenant chains.
 *
 * This is intentionally lightweight: append-only checkpoints in Postgres,
 * with helpers to save/load/resume/list/cleanup.
 */

import { runPsql, withPostgresPath } from "../lib/db.js";

const DEFAULT_DB = "cortana";
const VALID_STATES = new Set(["queued", "running", "completed", "failed", "paused"]);

class CheckpointError extends Error {}

type Json = Record<string, unknown>;

type SaveMetadata = {
  agent_role?: string;
  task_id?: number;
  trace_id?: string;
} & Json;

function utcNowIso(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function runPsqlQuery(db: string, sql: string): string {
  const result = runPsql(sql, { db, args: ["-X", "-q", "-At"], env: withPostgresPath(process.env) });
  if (result.status !== 0) {
    const err = (result.stderr || "").toString().trim();
    throw new CheckpointError(err || "psql command failed");
  }
  return (result.stdout || "").toString().trim();
}

function normalizeMetadata(metadata: SaveMetadata | null | undefined): SaveMetadata {
  return metadata || {};
}

function save(
  workflowId: string,
  stepId: string,
  state: string,
  metadata: SaveMetadata | null = null,
  db = DEFAULT_DB
): Json {
  if (!VALID_STATES.has(state)) {
    throw new CheckpointError(`Invalid state '${state}'. Must be one of: ${Array.from(VALID_STATES).sort().join(",")}`);
  }

  const meta = normalizeMetadata(metadata);
  const payloadJson = JSON.stringify(meta);

  const agentRole = meta.agent_role;
  const taskId = meta.task_id;
  const traceId = meta.trace_id;

  let taskSql = "NULL";
  if (taskId !== undefined && taskId !== null) {
    const parsed = Number.parseInt(String(taskId), 10);
    if (Number.isNaN(parsed)) {
      throw new CheckpointError("metadata.task_id must be an integer");
    }
    taskSql = String(parsed);
  }

  const agentSql = agentRole === undefined || agentRole === null ? "NULL" : `'${sqlQuote(String(agentRole))}'`;
  const traceSql = traceId === undefined || traceId === null ? "NULL" : `'${sqlQuote(String(traceId))}'`;

  const sql = `
    INSERT INTO cortana_workflow_checkpoints
      (workflow_id, step_id, state, agent_role, task_id, trace_id, payload)
    VALUES
      ('${sqlQuote(workflowId)}'::uuid,
       '${sqlQuote(stepId)}',
       '${sqlQuote(state)}',
       ${agentSql},
       ${taskSql},
       ${traceSql},
       '${sqlQuote(payloadJson)}'::jsonb)
    RETURNING row_to_json(cortana_workflow_checkpoints)::text;
    `;

  const out = runPsqlQuery(db, sql);
  if (!out) {
    throw new CheckpointError("Save returned no result");
  }
  return JSON.parse(out);
}

function load(workflowId: string, db = DEFAULT_DB): Json | null {
  const sql = `
    SELECT row_to_json(t)::text
    FROM (
      SELECT *
      FROM cortana_workflow_checkpoints
      WHERE workflow_id = '${sqlQuote(workflowId)}'::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) t;
    `;
  const out = runPsqlQuery(db, sql);
  if (!out) return null;
  return JSON.parse(out);
}

function resume(workflowId: string, db = DEFAULT_DB): Json {
  const last = load(workflowId, db);
  if (!last) {
    return {
      workflow_id: workflowId,
      resume_action: "start",
      next_step_id: null,
      reason: "No checkpoint found",
      at: utcNowIso(),
    };
  }

  const state = String(last.state ?? "");
  const stepId = String(last.step_id ?? "");
  const payload = (last.payload as Json) ?? {};

  if (state === "completed") {
    const nextStepId = payload.next_step_id;
    if (nextStepId) {
      return {
        workflow_id: workflowId,
        resume_action: "continue",
        next_step_id: String(nextStepId),
        reason: "Last step completed; continuing to payload.next_step_id",
        checkpoint: last,
        at: utcNowIso(),
      };
    }
    return {
      workflow_id: workflowId,
      resume_action: "done",
      next_step_id: null,
      reason: "Last checkpoint is completed and no next_step_id provided",
      checkpoint: last,
      at: utcNowIso(),
    };
  }

  return {
    workflow_id: workflowId,
    resume_action: "retry",
    next_step_id: stepId,
    reason: `Last checkpoint state '${state}' requires resuming current step`,
    checkpoint: last,
    at: utcNowIso(),
  };
}

function listWorkflows(activeOnly = false, db = DEFAULT_DB): Json[] {
  const where = activeOnly ? "WHERE state IN ('queued', 'running', 'failed', 'paused')" : "";

  const sql = `
    WITH latest AS (
      SELECT DISTINCT ON (workflow_id) *
      FROM cortana_workflow_checkpoints
      ORDER BY workflow_id, created_at DESC, id DESC
    )
    SELECT COALESCE(json_agg(row_to_json(latest) ORDER BY updated_at DESC), '[]'::json)::text
    FROM latest
    ${where};
    `;

  const out = runPsqlQuery(db, sql);
  if (!out) return [];
  return JSON.parse(out);
}

function parseOlderThanToInterval(olderThan: string): string {
  const match = olderThan.match(/^\s*(\d+)\s*([dhm])\s*$/);
  if (!match) {
    throw new CheckpointError("Invalid --older-than format. Use Nd, Nh, or Nm (example: 7d)");
  }
  const value = Number.parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "d") return `${value} days`;
  if (unit === "h") return `${value} hours`;
  return `${value} minutes`;
}

function cleanup(olderThan = "7d", db = DEFAULT_DB): Json {
  const interval = parseOlderThanToInterval(olderThan);
  const sql = `
    WITH deleted AS (
      DELETE FROM cortana_workflow_checkpoints
      WHERE created_at < NOW() - INTERVAL '${sqlQuote(interval)}'
      RETURNING id
    )
    SELECT json_build_object(
      'deleted', COUNT(*),
      'older_than', '${sqlQuote(olderThan)}',
      'interval', '${sqlQuote(interval)}'
    )::text
    FROM deleted;
    `;

  const out = runPsqlQuery(db, sql);
  if (!out) return { deleted: 0, older_than: olderThan, interval };
  return JSON.parse(out);
}

function parseMetadata(metadataStr: string | undefined): SaveMetadata {
  if (!metadataStr) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataStr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CheckpointError(`Invalid metadata JSON: ${msg}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CheckpointError("metadata JSON must be an object");
  }
  return parsed as SaveMetadata;
}

function usageExit(): never {
  console.error("Usage: checkpoint.ts <command> [options]");
  process.exit(2);
}

function parseArgs(argv: string[]): { db: string; command: string; args: string[] } {
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

  const command = args.shift();
  if (!command) usageExit();
  return { db, command, args };
}

async function main(): Promise<void> {
  const { db, command, args } = parseArgs(process.argv.slice(2));

  try {
    let result: Json | Json[] | null = null;

    if (command === "save") {
      if (args.length < 3) usageExit();
      const [workflowId, stepId, state] = args;
      const metadataIndex = args.indexOf("--metadata");
      const metadataStr = metadataIndex !== -1 ? args[metadataIndex + 1] : undefined;
      result = save(workflowId, stepId, state, parseMetadata(metadataStr), db);
    } else if (command === "load") {
      if (args.length < 1) usageExit();
      result = load(args[0], db);
    } else if (command === "resume") {
      if (args.length < 1) usageExit();
      result = resume(args[0], db);
    } else if (command === "list") {
      const activeOnly = args.includes("--active");
      result = listWorkflows(activeOnly, db);
    } else if (command === "cleanup") {
      const idx = args.indexOf("--older-than");
      const olderThan = idx !== -1 && args[idx + 1] ? args[idx + 1] : "7d";
      result = cleanup(olderThan, db);
    } else {
      throw new CheckpointError(`Unsupported command: ${command}`);
    }

    console.log(JSON.stringify({ ok: true, result }));
    process.exit(0);
  } catch (err) {
    if (err instanceof CheckpointError) {
      console.error(`CHECKPOINT_ERROR: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main();
