#!/usr/bin/env npx tsx

/** Prepare Covenant spawn payload + prompt using identity v1 defaults. */

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { resolveRepoPath } from "../lib/paths.js";

const WORKSPACE_ROOT = resolveRepoPath();
const HANDSHAKE_VALIDATOR = path.join(WORKSPACE_ROOT, "tools", "covenant", "validate_spawn_handshake.ts");
const PROMPT_BUILDER = path.join(WORKSPACE_ROOT, "tools", "covenant", "build_identity_spawn_prompt.ts");
const ROUTER = path.join(WORKSPACE_ROOT, "tools", "covenant", "route_workflow.ts");

const DEFAULT_OUTPUT_FORMAT = {
  type: "markdown",
  sections: ["summary", "changes", "validation", "risks", "next_steps"],
};

const DEFAULT_TIMEOUT_RETRY = {
  timeout_seconds: 1800,
  max_retries: 2,
  retry_on: ["transient_tool_failure", "network_timeout"],
  escalate_on: ["auth_failure", "permission_denied", "requirements_ambiguous"],
};

const DEFAULT_CALLBACK = {
  update_channel: "subagent_result_push",
  final_channel: "requester_session",
  heartbeat_interval_seconds: 300,
  on_blocked: "immediate",
};

const DEFAULT_CONSTRAINTS = {
  workspace_root: WORKSPACE_ROOT,
  allowed_paths: [WORKSPACE_ROOT],
  forbidden_actions: ["force_push", "destructive_delete", "external_message_without_approval"],
};

class PrepError extends Error {}

type Json = Record<string, any>;

function loadJson(filePath: string, label: string): any {
  if (!fs.existsSync(filePath)) {
    throw new PrepError(`${label} not found: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new PrepError(`${label} invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function toStringList(value: any): string[] | null {
  if (Array.isArray(value)) {
    const out = value.map((v) => String(v).trim()).filter((v) => v);
    return out.length ? out : null;
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return null;
}

function normalizePayload(raw: Json, legacyShim: boolean): [Json, string[]] {
  if (!legacyShim) return [raw, []];

  const normalized: Json = { ...raw };
  const notes: string[] = [];

  const mission = normalized.mission;
  const expectedOutcomes = normalized.expected_outcomes;
  const expectedOutcome = normalized.expected_outcome;

  delete normalized.mission;
  delete normalized.expected_outcomes;
  delete normalized.expected_outcome;

  if (!("objective" in normalized) && typeof mission === "string" && mission.trim()) {
    normalized.objective = mission.trim();
    notes.push("mapped legacy field 'mission' -> 'objective'");
  }

  if (!("success_criteria" in normalized)) {
    const criteria = toStringList(expectedOutcomes ?? expectedOutcome);
    if (criteria) {
      normalized.success_criteria = criteria;
      notes.push("mapped legacy field 'expected_outcome(s)' -> 'success_criteria'");
    }
  }

  if (!("output_format" in normalized)) {
    normalized.output_format = { ...DEFAULT_OUTPUT_FORMAT };
    notes.push("injected default 'output_format'");
  }

  if (!("timeout_retry_policy" in normalized)) {
    normalized.timeout_retry_policy = { ...DEFAULT_TIMEOUT_RETRY };
    notes.push("injected default 'timeout_retry_policy'");
  }

  if (!("callback" in normalized)) {
    normalized.callback = { ...DEFAULT_CALLBACK };
    notes.push("injected default 'callback'");
  } else if (typeof normalized.callback === "object" && normalized.callback && !("update_channel" in normalized.callback)) {
    normalized.callback = { ...DEFAULT_CALLBACK, ...normalized.callback };
    notes.push("filled missing callback.update_channel via compatibility defaults");
  }

  if (!("constraints" in normalized)) {
    normalized.constraints = { ...DEFAULT_CONSTRAINTS };
    notes.push("injected default 'constraints'");
  }

  return [normalized, notes];
}

function runCmd(cmd: string[]): void {
  const result = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || "").toString().trim();
    throw new PrepError(msg || `command failed: ${cmd.join(" ")}`);
  }
}

function maybeAutoRouteIdentity(payload: Json, autoRoute: boolean): [Json, string[]] {
  if (!autoRoute || payload.agent_identity_id) return [payload, []];

  if (!fs.existsSync(ROUTER)) {
    throw new PrepError(`routing tool not found: ${ROUTER}`);
  }

  const tmpPath = path.join(os.tmpdir(), `covenant-route-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(payload));

  let result;
  try {
    result = spawnSync(ROUTER, ["--plan", tmpPath], { encoding: "utf8" });
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }

  if (!result || result.status !== 0) {
    const msg = ((result?.stderr || result?.stdout) ?? "").toString().trim();
    throw new PrepError(`auto-route failed: ${msg}`);
  }

  let line: string | null = null;
  for (const raw of (result.stdout || "").toString().split(/\r?\n/)) {
    if (raw.startsWith("ROUTING_PLAN_JSON:")) {
      line = raw.slice("ROUTING_PLAN_JSON:".length).trim();
      break;
    }
  }
  if (!line) throw new PrepError("auto-route failed: missing ROUTING_PLAN_JSON output");

  let route: Json;
  try {
    route = JSON.parse(line);
  } catch (err) {
    throw new PrepError(`auto-route failed: invalid routing JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const identity = route.primary_agent_identity_id;
  if (typeof identity !== "string" || !identity.trim()) {
    throw new PrepError("auto-route failed: missing primary_agent_identity_id");
  }

  const updated = { ...payload, agent_identity_id: identity };
  return [updated, [`auto-routed missing 'agent_identity_id' -> '${identity}'`]];
}

function usageError(): never {
  console.error("usage: prepare_spawn.py <handshake-or-legacy.json> [--output-dir <dir>] [--legacy-shim] [--auto-route]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const payloadArg = args[0];
  if (!payloadArg) usageError();

  const outputDir = (() => {
    const idx = args.indexOf("--output-dir");
    if (idx >= 0 && args[idx + 1]) return args[idx + 1];
    const eq = args.find((a) => a.startsWith("--output-dir="));
    if (eq) return eq.slice("--output-dir=".length);
    return "/tmp/covenant-spawn";
  })();

  const legacyShim = args.includes("--legacy-shim");
  const autoRoute = args.includes("--auto-route");

  try {
    const payloadPath = path.resolve(payloadArg);
    const outputPath = path.resolve(outputDir);

    const raw = loadJson(payloadPath, "payload");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new PrepError("payload root must be an object");
    }

    let normalized: Json;
    let notes: string[];
    [normalized, notes] = normalizePayload(raw, legacyShim);
    let routeNotes: string[];
    [normalized, routeNotes] = maybeAutoRouteIdentity(normalized, autoRoute);
    notes = notes.concat(routeNotes);

    fs.mkdirSync(outputPath, { recursive: true });
    const normalizedPath = path.join(outputPath, "handshake.normalized.json");
    const promptPath = path.join(outputPath, "spawn.prompt.txt");

    fs.writeFileSync(normalizedPath, JSON.stringify(normalized, null, 2) + "\n");

    runCmd([HANDSHAKE_VALIDATOR, normalizedPath]);
    runCmd([PROMPT_BUILDER, normalizedPath, "--output", promptPath]);

    console.log(`SPAWN_PREPARED: ${outputPath}`);
    console.log(`HANDSHAKE_PATH: ${normalizedPath}`);
    console.log(`PROMPT_PATH: ${promptPath}`);
    if (notes.length) {
      console.log("COMPAT_SHIM_APPLIED:");
      notes.forEach((n) => console.log(`- ${n}`));
    }
  } catch (err) {
    if (err instanceof PrepError) {
      console.error(`SPAWN_PREP_INVALID: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
