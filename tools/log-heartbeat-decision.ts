#!/usr/bin/env npx tsx
import path from "path";
import { spawnSync } from "child_process";
import fs from "fs";

function usage(): void {
  const script = path.basename(process.argv[1] ?? "log-heartbeat-decision.ts");
  process.stderr.write(
    `Usage: ${script} <check_name> <outcome> <reasoning> <confidence> [data_inputs_json]\n`
  );
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[ -]/g, "_");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length < 4) {
    usage();
    return 1;
  }

  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const logDecisionScript = path.join(scriptDir, "log-decision.ts");

  const checkNameRaw = argv[0] ?? "";
  const outcome = argv[1] ?? "";
  const reasoning = argv[2] ?? "";
  const confidence = argv[3] ?? "";
  const dataInputsJson = argv[4] ?? "{}";

  if (!fs.existsSync(logDecisionScript)) {
    process.stderr.write(
      `Error: log-decision.ts not found or not executable at ${logDecisionScript}\n`
    );
    return 1;
  }

  if (!isExecutable(logDecisionScript)) {
    process.stderr.write(
      `Error: log-decision.ts not found or not executable at ${logDecisionScript}\n`
    );
    return 1;
  }

  if (!/^(success|skipped|fail)$/.test(outcome)) {
    process.stderr.write("Error: outcome must be one of: success, skipped, fail\n");
    return 1;
  }

  const checkName = normalize(checkNameRaw);

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
      process.stderr.write(`Error: unsupported check_name '${checkNameRaw}'\n`);
      process.stderr.write(
        "Supported: email_triage, calendar, portfolio, fitness, weather, budget, tech_news, mission_advancement, task_queue_execution, system_health\n"
      );
      return 1;
  }

  const res = spawnSync(
    logDecisionScript,
    [
      "heartbeat",
      actionType,
      actionName,
      outcome,
      reasoning,
      confidence,
      "",
      "",
      dataInputsJson,
    ],
    { stdio: "inherit" }
  );

  return res.status ?? 1;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
