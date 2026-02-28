#!/usr/bin/env npx tsx

/** Arbiter module for Covenant orchestration v2. */

import fs from "fs";
import path from "path";

const ALLOWED_AGENTS = new Set([
  "agent.monitor.v1",
  "agent.huragok.v1",
  "agent.researcher.v1",
  "agent.oracle.v1",
  "agent.librarian.v1",
]);

const DEFAULT_BUDGET = {
  max_total_timeout_seconds: 7200,
  max_total_retries: 8,
};

type Json = Record<string, unknown>;

type ReviewResult = {
  approved: boolean;
  requires_human_review: boolean;
  issues: string[];
  warnings: string[];
  resource_budget: { total_timeout_seconds: number; total_retries: number };
};

export function reviewPlan(plan: Json, request: Json | null = null): ReviewResult {
  const req = request ?? {};
  const issues: string[] = [];
  const warnings: string[] = [];

  const steps = plan.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return {
      approved: false,
      requires_human_review: true,
      issues: ["plan.steps must be a non-empty array"],
      warnings: [],
      resource_budget: { total_timeout_seconds: 0, total_retries: 0 },
    };
  }

  const stepIds = new Set(
    steps
      .filter((s) => s && typeof s === "object")
      .map((s) => (s as Json).step_id)
      .filter((id) => typeof id === "string") as string[]
  );

  let totalTimeout = 0;
  let totalRetries = 0;

  steps.forEach((step, idx) => {
    if (!step || typeof step !== "object") {
      issues.push(`steps[${idx}] must be an object`);
      return;
    }
    const stepObj = step as Json;

    const agent = stepObj.agent_identity_id;
    if (typeof agent !== "string" || !ALLOWED_AGENTS.has(agent)) {
      issues.push(`steps[${idx}] has unknown agent_identity_id '${String(agent)}'`);
    }

    const conf = stepObj.confidence;
    const threshold = stepObj.confidence_threshold;
    if (typeof conf !== "number" || typeof threshold !== "number") {
      issues.push(`steps[${idx}] confidence/threshold must be numeric`);
    } else if (conf < threshold) {
      issues.push(
        `steps[${idx}] confidence ${conf.toFixed(2)} below threshold ${threshold.toFixed(2)}; requires re-planning or human review`
      );
    }

    const deps = stepObj.depends_on;
    if (!Array.isArray(deps)) {
      issues.push(`steps[${idx}] depends_on must be an array`);
    } else {
      for (const dep of deps) {
        if (typeof dep !== "string" || !stepIds.has(dep)) {
          issues.push(`steps[${idx}] depends_on unknown step_id '${String(dep)}'`);
        }
      }
    }

    const retry = stepObj.retry_policy;
    const retryObj = retry && typeof retry === "object" ? (retry as Json) : null;
    if (!retryObj) {
      issues.push(`steps[${idx}] retry_policy must be an object`);
    }

    const timeout = retryObj ? retryObj.timeout_seconds : null;
    const retries = retryObj ? retryObj.max_retries : null;

    if (typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 0) {
      totalTimeout += timeout;
    } else {
      issues.push(`steps[${idx}] retry_policy.timeout_seconds must be integer >= 0`);
    }

    if (typeof retries === "number" && Number.isInteger(retries) && retries >= 0) {
      totalRetries += retries;
    } else {
      issues.push(`steps[${idx}] retry_policy.max_retries must be integer >= 0`);
    }

    const gate = stepObj.quality_gate;
    if (!gate || typeof gate !== "object" || !(gate as Json).checks) {
      issues.push(`steps[${idx}] must define a quality_gate with checks`);
    }

    const handoff = stepObj.handoff;
    if (!handoff || typeof handoff !== "object" || !(handoff as Json).output_contract) {
      issues.push(`steps[${idx}] must define handoff contract`);
    }
  });

  const budgetReq = req.resource_budget && typeof req.resource_budget === "object" ? (req.resource_budget as Json) : {};
  const maxTimeout = Number.parseInt(String(budgetReq.max_total_timeout_seconds ?? DEFAULT_BUDGET.max_total_timeout_seconds), 10);
  const maxRetries = Number.parseInt(String(budgetReq.max_total_retries ?? DEFAULT_BUDGET.max_total_retries), 10);

  if (totalTimeout > maxTimeout) {
    issues.push(`timeout budget exceeded: ${totalTimeout}s > ${maxTimeout}s`);
  }
  if (totalRetries > maxRetries) {
    issues.push(`retry budget exceeded: ${totalRetries} > ${maxRetries}`);
  }

  const maxSteps = Number.parseInt(String(req.max_steps ?? 6), 10);
  if (steps.length > maxSteps) {
    warnings.push(`plan uses ${steps.length} steps; exceeds preferred max_steps`);
  }

  const approved = issues.length === 0;
  const requiresHuman = issues.some((i) => i.toLowerCase().includes("human review")) || !approved;

  return {
    approved,
    requires_human_review: requiresHuman,
    issues,
    warnings,
    resource_budget: { total_timeout_seconds: totalTimeout, total_retries: totalRetries },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: critic.ts <plan.json> [--request <request.json>]");
    process.exit(2);
  }

  const planPath = path.resolve(args[0]);
  let requestPath: string | null = null;
  const requestIndex = args.indexOf("--request");
  if (requestIndex !== -1 && args[requestIndex + 1]) {
    requestPath = path.resolve(args[requestIndex + 1]);
  }

  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const request = requestPath ? JSON.parse(fs.readFileSync(requestPath, "utf8")) : {};
  const result = reviewPlan(plan, request);
  console.log(JSON.stringify(result, null, 2));
}

main();
