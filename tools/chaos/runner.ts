#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fetchMttrScorecard, recordEvents, recordRun } from "./mttr.js";
import { serializeResults } from "./scenarios/base.js";
import { CronFailureScenario } from "./scenarios/cron_failure.js";
import { DbConnectionIssueScenario } from "./scenarios/db_connection_issue.js";
import { HeartbeatMissScenario } from "./scenarios/heartbeat_miss.js";
import { MemoryCorruptionScenario } from "./scenarios/memory_corruption.js";
import { ToolUnavailabilityScenario } from "./scenarios/tool_unavailability.js";
import { repoRoot } from "../lib/paths.js";

type Args = {
  scenarios: string[];
  mode: "simulation" | "scheduled";
  windowDays: number;
  noRegression: boolean;
  noDb: boolean;
  json: boolean;
  dryRun: boolean;
};

const SCENARIO_REGISTRY: Record<string, new () => { run(): Promise<any> }> = {
  tool_unavailability: ToolUnavailabilityScenario,
  cron_failure: CronFailureScenario,
  db_connection_issue: DbConnectionIssueScenario,
  memory_corruption: MemoryCorruptionScenario,
  heartbeat_miss: HeartbeatMissScenario,
};

const HEALTH_CHECK_SCRIPT = path.join(repoRoot(), "proprioception", "run_health_checks.py");

function parseArgs(argv: string[]): Args {
  const args: Args = {
    scenarios: Object.keys(SCENARIO_REGISTRY),
    mode: "simulation",
    windowDays: 30,
    noRegression: false,
    noDb: false,
    json: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--scenarios") {
      const vals: string[] = [];
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith("--")) {
        vals.push(argv[j]);
        j += 1;
      }
      args.scenarios = vals.length ? vals : [];
      i = j - 1;
    } else if (a === "--mode") {
      args.mode = (argv[++i] as Args["mode"]) ?? "simulation";
    } else if (a === "--window-days") {
      args.windowDays = Number.parseInt(argv[++i] ?? "30", 10);
    } else if (a === "--no-regression") {
      args.noRegression = true;
    } else if (a === "--no-db") {
      args.noDb = true;
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    }
  }

  return args;
}

function runRegressionProbe(label: string): Record<string, unknown> {
  const start = performance.now();
  const proc = spawnSync(process.execPath, [HEALTH_CHECK_SCRIPT, "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  const elapsedMs = Math.trunc(performance.now() - start);
  return {
    label,
    ok: proc.status === 0,
    elapsed_ms: elapsedMs,
    stderr: (proc.stderr || "").slice(0, 500),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) args.noDb = true;
  const runId = randomUUID();

  const unknown = args.scenarios.filter((s) => !(s in SCENARIO_REGISTRY));
  if (unknown.length) {
    console.error(`Unknown scenarios: ${unknown.join(", ")}`);
    return 2;
  }

  const regression: Array<Record<string, unknown>> = [];
  if (!args.noRegression) regression.push(runRegressionProbe("pre"));

  const results = [];
  for (const name of args.scenarios) {
    const scenario = new SCENARIO_REGISTRY[name]();
    results.push(await scenario.run());
  }

  if (!args.noRegression) regression.push(runRegressionProbe("post"));

  const serialized = serializeResults(results as any[]);
  const recoveredCount = serialized.filter((r) => r.recovered).length;
  const status = recoveredCount === serialized.length && (regression.length ? regression.every((r) => r.ok === true) : true) ? "passed" : "failed";

  const runMeta = {
    regression,
    safe_mode: true,
    isolation: "temp_files_and_simulated_failures_only",
  };

  if (!args.noDb) {
    recordRun(runId, args.mode, serialized.length, status, runMeta);
    recordEvents(runId, serialized as any[]);
  }

  const output = {
    run_id: runId,
    mode: args.mode,
    status,
    scenarios: serialized,
    regression,
    mttr_scorecard: !args.noDb ? fetchMttrScorecard(args.windowDays) : null,
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Chaos run ${runId}: ${status} (${serialized.length} scenarios)`);
    for (const s of serialized) {
      console.log(` - ${s.name}: detected=${s.detected} recovered=${s.recovered} recovery_ms=${s.recovery_ms}`);
    }
  }

  return status === "passed" ? 0 : 1;
}

main().then((code) => process.exit(code));
