#!/usr/bin/env npx tsx
import path from "path";
import { randomUUID } from "crypto";
import db from "./lib/db.js";
const { runPsql, withPostgresPath } = db;

function usage(): void {
  const script = path.basename(process.argv[1] ?? "log-decision.ts");
  process.stderr.write(
    `Usage: ${script} <trigger_type> <action_type> <action_name> <outcome> [reasoning] [confidence] [event_id] [task_id] [data_inputs_json]\n`
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length < 4) {
    usage();
    return 1;
  }

  const triggerType = argv[0] ?? "";
  const actionType = argv[1] ?? "";
  const actionName = argv[2] ?? "";
  const outcome = argv[3] ?? "";
  const reasoning = argv[4] ?? "";
  const confidence = argv[5] ?? "";
  const eventId = argv[6] ?? "";
  const taskId = argv[7] ?? "";
  const dataInputsJson = argv[8] ?? "";

  const traceId = randomUUID().toLowerCase();

  const safeConfidence = confidence || "";
  const safeEventId = eventId || "";
  const safeTaskId = taskId || "";
  const safeDataInputs = dataInputsJson || "{}";

  const q = (value: string): string => `'${String(value).replace(/'/g, "''")}'`;

  const sql = `
INSERT INTO cortana_decision_traces (
  trace_id,
  trigger_type,
  action_type,
  action_name,
  outcome,
  reasoning,
  confidence,
  event_id,
  task_id,
  data_inputs,
  metadata,
  completed_at
) VALUES (
  ${q(traceId)},
  ${q(triggerType)},
  ${q(actionType)},
  ${q(actionName)},
  ${q(outcome)},
  NULLIF(${q(reasoning)}, ''),
  NULLIF(${q(safeConfidence)}, '')::numeric,
  NULLIF(${q(safeEventId)}, '')::bigint,
  NULLIF(${q(safeTaskId)}, '')::bigint,
  COALESCE(NULLIF(${q(safeDataInputs)}, ''), '{}')::jsonb,
  jsonb_build_object('logged_by', 'tools/log-decision.ts'),
  CASE WHEN ${q(outcome)} IN ('success', 'fail', 'skipped') THEN NOW() ELSE NULL END
);
`;

  const res = runPsql(sql, {
    db: "cortana",
    args: ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A"],
    env: withPostgresPath(process.env),
    stdio: ["ignore", "ignore", "inherit"],
  });

  if (res.status !== 0) {
    return 1;
  }

  process.stdout.write(`${traceId}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
