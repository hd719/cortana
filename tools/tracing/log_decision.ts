#!/usr/bin/env npx tsx

import { randomUUID } from "crypto";
import { runPsql, withPostgresPath } from "../lib/db.js";

type Dict = Record<string, any>;

function parseJson(value: string | undefined, field: string): Dict {
  if (!value) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (e: any) { throw new Error(`Invalid JSON for ${field}: ${e.message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${field} must be a JSON object`);
  return parsed as Dict;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}
function hasFlag(name: string): boolean { return process.argv.includes(name); }

try {
  const traceId = argValue("--trace-id") ?? randomUUID();
  const eventIdRaw = argValue("--event-id");
  const taskIdRaw = argValue("--task-id");
  const runId = argValue("--run-id");
  const trigger = argValue("--trigger");
  const actionType = argValue("--action-type");
  const actionName = argValue("--action-name");
  const reasoning = argValue("--reasoning");
  const confidenceRaw = argValue("--confidence");
  const outcome = argValue("--outcome") ?? "unknown";
  const dataInputsRaw = argValue("--data-inputs");
  const metadataRaw = argValue("--metadata");

  if (!trigger || !actionType || !actionName) {
    console.error("Usage: --trigger <v> --action-type <v> --action-name <v> [--trace-id ... --event-id ... --task-id ... --run-id ... --reasoning ... --confidence ... --outcome ... --data-inputs <json> --metadata <json>]");
    process.exit(2);
  }

  if (confidenceRaw !== undefined) {
    const confidence = Number(confidenceRaw);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("confidence must be between 0 and 1");
  }

  const dataInputs = JSON.stringify(parseJson(dataInputsRaw, "--data-inputs"));
  const metadata = JSON.stringify(parseJson(metadataRaw, "--metadata"));

  const db = process.env.CORTANA_DATABASE_URL || process.env.DATABASE_URL || "cortana";

  const sql = `
    INSERT INTO cortana_decision_traces (
      trace_id,event_id,task_id,run_id,trigger_type,action_type,action_name,
      reasoning,confidence,outcome,data_inputs,metadata
    ) VALUES (
      :'trace_id', NULLIF(:'event_id','')::bigint, NULLIF(:'task_id','')::bigint,
      NULLIF(:'run_id',''), :'trigger', :'action_type', :'action_name',
      NULLIF(:'reasoning',''), NULLIF(:'confidence','')::numeric, :'outcome',
      :'data_inputs'::jsonb, :'metadata'::jsonb
    )
    ON CONFLICT (trace_id) DO UPDATE SET
      event_id = EXCLUDED.event_id,
      task_id = EXCLUDED.task_id,
      run_id = EXCLUDED.run_id,
      trigger_type = EXCLUDED.trigger_type,
      action_type = EXCLUDED.action_type,
      action_name = EXCLUDED.action_name,
      reasoning = EXCLUDED.reasoning,
      confidence = EXCLUDED.confidence,
      outcome = EXCLUDED.outcome,
      data_inputs = EXCLUDED.data_inputs,
      metadata = EXCLUDED.metadata;
  `;

  const result = runPsql(sql, {
    db,
    args: [
      "-v", `trace_id=${traceId}`,
      "-v", `event_id=${eventIdRaw ?? ""}`,
      "-v", `task_id=${taskIdRaw ?? ""}`,
      "-v", `run_id=${runId ?? ""}`,
      "-v", `trigger=${trigger}`,
      "-v", `action_type=${actionType}`,
      "-v", `action_name=${actionName}`,
      "-v", `reasoning=${reasoning ?? ""}`,
      "-v", `confidence=${confidenceRaw ?? ""}`,
      "-v", `outcome=${outcome}`,
      "-v", `data_inputs=${dataInputs}`,
      "-v", `metadata=${metadata}`,
    ],
    env: withPostgresPath(process.env),
    stdio: "pipe",
  });

  if (result.status !== 0) {
    console.error(`failed to log decision trace: ${result.stderr || result.stdout || "psql error"}`.trim());
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, trace_id: traceId }));
  process.exit(0);
} catch (e: any) {
  console.error(String(e.message || e));
  process.exit(1);
}
