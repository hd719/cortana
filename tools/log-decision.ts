#!/usr/bin/env npx tsx
import path from "path";
import { randomUUID } from "crypto";
import { runPsql, withPostgresPath } from "./lib/db.js";

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
  :'trace_id',
  :'trigger_type',
  :'action_type',
  :'action_name',
  :'outcome',
  NULLIF(:'reasoning', ''),
  NULLIF(:'confidence', '')::numeric,
  NULLIF(:'event_id', '')::bigint,
  NULLIF(:'task_id', '')::bigint,
  COALESCE(NULLIF(:'data_inputs', ''), '{}')::jsonb,
  jsonb_build_object('logged_by', 'tools/log-decision.sh'),
  CASE WHEN :'outcome' IN ('success', 'fail', 'skipped') THEN NOW() ELSE NULL END
);
`;

  const res = runPsql(sql, {
    db: "cortana",
    args: [
      "-v",
      `trace_id=${traceId}`,
      "-v",
      `trigger_type=${triggerType}`,
      "-v",
      `action_type=${actionType}`,
      "-v",
      `action_name=${actionName}`,
      "-v",
      `outcome=${outcome}`,
      "-v",
      `reasoning=${reasoning}`,
      "-v",
      `confidence=${safeConfidence}`,
      "-v",
      `event_id=${safeEventId}`,
      "-v",
      `task_id=${safeTaskId}`,
      "-v",
      `data_inputs=${safeDataInputs}`,
    ],
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
