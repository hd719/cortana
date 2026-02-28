#!/usr/bin/env npx tsx

/** Route Covenant operational workflows with Roland-Arbiter-Executor (v2). */

import fs from "fs";
import path from "path";
import { buildPlan } from "./planner.js";
import { reviewPlan } from "./critic.js";
import { buildExecutionState, decideRetry } from "./executor.js";

const ALLOWED_AGENTS = new Set([
  "agent.monitor.v1",
  "agent.huragok.v1",
  "agent.researcher.v1",
  "agent.oracle.v1",
  "agent.librarian.v1",
]);

class RoutingError extends Error {}

type Json = Record<string, any>;

function sortObject(value: any): any {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  const out: Json = {};
  Object.keys(value)
    .sort()
    .forEach((key) => {
      out[key] = sortObject(value[key]);
    });
  return out;
}

function stringifySorted(value: any): string {
  return JSON.stringify(sortObject(value));
}

function loadJson(filePath: string, label: string): Json {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new RoutingError(`${label} not found: ${resolved}`);
  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (err) {
    throw new RoutingError(`${label} invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RoutingError(`${label} root must be an object`);
  }
  return payload as Json;
}

function orchestrate(payload: Json): Json {
  const plan = buildPlan(payload);
  const critique = reviewPlan(plan, payload);
  const execution = buildExecutionState(plan, critique);
  return {
    protocol_version: "covenant-pce-v2",
    request: payload,
    plan,
    critique,
    execution,
  };
}

function planFailure(payload: Json): Json {
  const failureType = payload.failure_type;
  const agentId = payload.agent_identity_id;
  const attempt = payload.attempt;
  const maxRetries = payload.max_retries;

  if (typeof failureType !== "string" || !failureType.trim()) {
    throw new RoutingError("failure_type is required");
  }
  if (typeof agentId !== "string" || !ALLOWED_AGENTS.has(agentId)) {
    throw new RoutingError("agent_identity_id must be one of known Covenant identities");
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RoutingError("attempt must be integer >= 1");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RoutingError("max_retries must be integer >= 0");
  }

  const decision = decideRetry(agentId, failureType, attempt, maxRetries);
  return {
    action: decision.action,
    state: String(decision.action).startsWith("escalate") ? "blocked" : "in_progress",
    route_to: decision.route_to,
    reason: decision.reason,
    required_decision: String(decision.action).startsWith("escalate")
      ? "Cortana should narrow scope, switch agent, or request human input."
      : null,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const planIdx = args.indexOf("--plan");
  const failIdx = args.indexOf("--failure");
  const planPath = planIdx >= 0 ? args[planIdx + 1] : undefined;
  const failPath = failIdx >= 0 ? args[failIdx + 1] : undefined;

  if (!!planPath === !!failPath) {
    console.error(
      "Usage: route_workflow.py --plan <routing-request.json> | --failure <failure-event.json>"
    );
    process.exit(2);
  }

  try {
    if (planPath) {
      const result = orchestrate(loadJson(planPath, "routing request"));
      console.log("ROUTING_PLAN_JSON: " + stringifySorted(result));
      return;
    }

    const result = planFailure(loadJson(failPath!, "failure event"));
    console.log("ROUTING_FAILURE_PLAN_JSON: " + stringifySorted(result));
  } catch (err) {
    if (err instanceof RoutingError) {
      console.error(`ROUTING_INVALID: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
