#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { runPsql, withPostgresPath } from "./lib/db.js";
import { stringifyJson } from "./lib/json-file.js";
import { getScriptDir } from "./lib/paths.js";

const args = process.argv.slice(2);

if (args.length < 4) {
  console.error(
    `Usage: ${process.argv[1] ?? "log-heartbeat-decision.ts"} <check_name> <outcome> <reasoning> <confidence> [data_inputs_json]`
  );
  process.exit(1);
}

const [checkNameRaw, outcome, reasoningRaw, confidenceRaw, dataInputsRaw] = args;
const scriptDir = getScriptDir(import.meta.url);
const logDecisionScript = path.join(scriptDir, "log-decision.sh");

try {
  fs.accessSync(logDecisionScript, fs.constants.X_OK);
} catch {
  console.error(
    `Error: log-decision.sh not found or not executable at ${logDecisionScript}`
  );
  process.exit(1);
}

if (!outcome || !["success", "skipped", "fail"].includes(outcome)) {
  console.error("Error: outcome must be one of: success, skipped, fail");
  process.exit(1);
}

const normalize = (value: string) => value.toLowerCase().replace(/[ -]/g, "_");
const checkName = normalize(checkNameRaw ?? "");

let actionType = "";
let actionName = "";

switch (checkName) {
  case "email":
  case "email_triage":
    actionType = "email_triage";
    actionName = "heartbeat_email_triage";
    break;
  case "calendar":
  case "calendar_check":
  case "calendar_lookahead":
    actionType = "calendar_check";
    actionName = "heartbeat_calendar_lookahead";
    break;
  case "portfolio":
  case "portfolio_check":
  case "portfolio_alerts":
    actionType = "portfolio_check";
    actionName = "heartbeat_portfolio_alerts";
    break;
  case "fitness":
  case "fitness_check":
  case "fitness_checkin":
    actionType = "fitness_check";
    actionName = "heartbeat_fitness_checkin";
    break;
  case "weather":
  case "weather_check":
    actionType = "weather_check";
    actionName = "heartbeat_weather";
    break;
  case "budget":
  case "budget_check":
  case "api_budget":
  case "api_budget_check":
    actionType = "budget_check";
    actionName = "heartbeat_api_budget_check";
    break;
  case "tech_news":
  case "news":
  case "tech":
    actionType = "tech_news";
    actionName = "heartbeat_tech_news";
    break;
  case "mission":
  case "mission_task":
  case "mission_advancement":
    actionType = "mission_task";
    actionName = "heartbeat_mission_advancement";
    break;
  case "task_execution":
  case "task_queue_execution":
  case "task_queue":
    actionType = "task_execution";
    actionName = "heartbeat_task_queue_execution";
    break;
  case "system_health":
  case "health":
  case "watchlist":
  case "proactive_intelligence":
    actionType = "system_health";
    actionName = "heartbeat_system_health";
    break;
  default:
    console.error(`Error: unsupported check_name '${checkNameRaw}'`);
    console.error(
      "Supported: email_triage, calendar, portfolio, fitness, weather, budget, tech_news, mission_advancement, task_queue_execution, system_health"
    );
    process.exit(1);
}

const triggerType = "heartbeat";
const reasoning = reasoningRaw ?? "";
const confidence = confidenceRaw ?? "";
const eventId = "";
const taskId = "";
const dataInputs =
  dataInputsRaw !== undefined && dataInputsRaw !== \"\"
    ? dataInputsRaw
    : stringifyJson({});
const traceId = randomUUID().toLowerCase();

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

const result = runPsql(sql, {
  db: "cortana",
  args: [
    "-v",
    "ON_ERROR_STOP=1",
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
    `confidence=${confidence}`,
    "-v",
    `event_id=${eventId}`,
    "-v",
    `task_id=${taskId}`,
    "-v",
    `data_inputs=${dataInputs}`,
  ],
  env: withPostgresPath(process.env),
  stdio: "ignore",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(traceId);
