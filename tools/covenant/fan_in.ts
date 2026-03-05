#!/usr/bin/env npx tsx

/** Fan-in helpers for Covenant parallel execution groups. */

import fs from "fs";
import path from "path";
import { runPsql, withPostgresPath } from "../lib/db.js";
import { resolveRepoPath } from "../lib/paths.js";
import { groupIsComplete } from "./executor.js";

const DEFAULT_DB = "cortana";
const WORKSPACE_ROOT = resolveRepoPath();

class FanInError extends Error {}

type Json = Record<string, any>;

type Args = {
  command: "aggregate" | "check" | "summarize";
  chainId: string;
  group: string;
  db: string;
  completed?: string;
  completedJson?: string;
};

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function runPsqlQuery(db: string, sql: string): string {
  const result = runPsql(sql, { db, args: ["-X", "-q", "-At"], env: withPostgresPath(process.env) });
  if (result.status !== 0) {
    const err = (result.stderr || "").toString().trim();
    throw new FanInError(err || "psql command failed");
  }
  return (result.stdout || "").toString().trim();
}

function loadPlan(chainId: string): Json {
  const candidates = [
    path.join(WORKSPACE_ROOT, "tools", "covenant", "chains", `${chainId}.plan.json`),
    path.join("/tmp/covenant-spawn", `${chainId}.plan.json`),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  }
  throw new FanInError(
    `Plan not found for chain_id=${chainId}. Expected one of: ${candidates.join(", ")}`
  );
}

function groupStepIds(plan: Json, parallelGroup: string): Set<string> {
  const ids = new Set<string>();
  const steps = plan.steps;
  if (!Array.isArray(steps)) return ids;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const stepObj = step as Json;
    const sid = stepObj.step_id;
    const grp = stepObj.parallel_group;
    if (typeof sid === "string" && typeof grp === "string" && grp.trim() === parallelGroup) {
      ids.add(sid);
    }
  }
  return ids;
}

function aggregate(chainId: string, parallelGroup: string, db = DEFAULT_DB): Json {
  const plan = loadPlan(chainId);
  const groupSteps = groupStepIds(plan, parallelGroup);
  if (!groupSteps.size) {
    throw new FanInError(`No steps found for parallel_group '${parallelGroup}'`);
  }

  const stepIdList = Array.from(groupSteps)
    .sort()
    .map((s) => `'${sqlQuote(s)}'`)
    .join(",");

  const sql =
    "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.created_at ASC), '[]'::json)::text " +
    "FROM (" +
    "SELECT id, chain_id, from_agent, to_agent, artifact_type, payload, created_by, consumed_at, created_at " +
    "FROM cortana_handoff_artifacts " +
    `WHERE chain_id = '${sqlQuote(chainId)}'::uuid ` +
    "AND (" +
    `  (payload ? 'parallel_group' AND payload->>'parallel_group' = '${sqlQuote(parallelGroup)}') ` +
    `  OR (payload ? 'step_id' AND payload->>'step_id' IN (${stepIdList}))` +
    ") " +
    "ORDER BY created_at ASC" +
    ") t;";

  const out = runPsqlQuery(db, sql);
  const artifacts = JSON.parse(out || "[]");
  return {
    ok: true,
    chain_id: chainId,
    parallel_group: parallelGroup,
    group_step_ids: Array.from(groupSteps).sort(),
    artifact_count: artifacts.length,
    artifacts,
  };
}

function checkBarrier(chainId: string, parallelGroup: string, completedSteps: Set<string>): Json {
  const plan = loadPlan(chainId);
  const stepIds = Array.from(groupStepIds(plan, parallelGroup)).sort();
  if (!stepIds.length) {
    throw new FanInError(`No steps found for parallel_group '${parallelGroup}'`);
  }

  const completed = groupIsComplete(plan, parallelGroup, completedSteps);
  const pending = stepIds.filter((id) => !completedSteps.has(id));
  return {
    ok: true,
    chain_id: chainId,
    parallel_group: parallelGroup,
    group_step_ids: stepIds,
    completed,
    pending_step_ids: pending,
  };
}

function summarize(chainId: string, parallelGroup: string, db = DEFAULT_DB): Json {
  const collected = aggregate(chainId, parallelGroup, db);
  const artifacts = collected.artifacts as Json[];

  const lines = [
    `Parallel fan-in summary for group '${parallelGroup}' (chain ${chainId})`,
    `Artifacts collected: ${artifacts.length}`,
    "",
  ];

  artifacts.forEach((item, idx) => {
    const payload = item && typeof item === "object" ? (item.payload as Json) : {};
    const summary = payload && typeof payload === "object" ? (payload as Json).summary : undefined;
    const risks = payload && typeof payload === "object" ? (payload as Json).risks : undefined;

    lines.push(
      `[${idx + 1}] artifact_id=${item.id} type=${item.artifact_type} from=${item.from_agent}`
    );
    if (typeof summary === "string" && summary.trim()) {
      lines.push(`  summary: ${summary.trim()}`);
    }
    if (Array.isArray(risks) && risks.length) {
      lines.push(`  risks: ${risks.map((r) => String(r)).join(", ")}`);
    }
  });

  const unified = lines.join("\n").trim();
  return {
    ok: true,
    chain_id: chainId,
    parallel_group: parallelGroup,
    artifact_count: artifacts.length,
    context_block: unified,
  };
}

function parseCompletedSteps(args: Args): Set<string> {
  if (args.completedJson) {
    const data = JSON.parse(fs.readFileSync(args.completedJson, "utf8"));
    if (!Array.isArray(data)) {
      throw new FanInError("completed-json must be a JSON array");
    }
    return new Set(data.map((x) => String(x)));
  }
  if (args.completed) {
    return new Set(args.completed.split(",").map((x) => x.trim()).filter(Boolean));
  }
  return new Set();
}

function usageError(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
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
  if (command !== "aggregate" && command !== "check" && command !== "summarize") {
    usageError("command must be one of: aggregate, check, summarize");
  }

  const getValue = (flag: string): string | undefined => {
    const eqPrefix = `${flag}=`;
    for (let i = 0; i < args.length; i += 1) {
      const item = args[i];
      if (item === flag) return args[i + 1];
      if (item.startsWith(eqPrefix)) return item.slice(eqPrefix.length);
    }
    return undefined;
  };

  const chainId = getValue("--chain-id") ?? "";
  const group = getValue("--group") ?? "";
  if (!chainId) usageError("--chain-id is required");
  if (!group) usageError("--group is required");

  return {
    command,
    chainId,
    group,
    db,
    completed: getValue("--completed"),
    completedJson: getValue("--completed-json"),
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.command === "aggregate") {
      console.log(JSON.stringify(aggregate(args.chainId, args.group, args.db), null, 2));
      process.exit(0);
    }

    if (args.command === "check") {
      const completed = parseCompletedSteps(args);
      console.log(JSON.stringify(checkBarrier(args.chainId, args.group, completed), null, 2));
      process.exit(0);
    }

    console.log(JSON.stringify(summarize(args.chainId, args.group, args.db), null, 2));
    process.exit(0);
  } catch (err) {
    if (err instanceof FanInError || err instanceof SyntaxError) {
      console.error(`FAN_IN_ERROR: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
