#!/usr/bin/env npx tsx

/** Smoke tests for Covenant parallel fan-out/fan-in execution. */

import { buildExecutionState } from "./executor.js";
import { buildPlan } from "./planner.js";

type Json = Record<string, any>;

function approvedCritique(): Json {
  return {
    approved: true,
    requires_human_review: false,
    issues: [],
    warnings: [],
    resource_budget: { total_timeout_seconds: 0, total_retries: 0 },
  };
}

function assert(condition: boolean, payload: any): void {
  if (!condition) {
    throw new Error(JSON.stringify(payload));
  }
}

async function main(): Promise<void> {
  const request = {
    objective: "Run parallel research on three market angles then synthesize",
    handoff_pattern: "parallel_research",
    parallel_research_angles: ["rates", "regulatory", "demand"],
  };
  const plan = buildPlan(request);
  const critique = approvedCritique();

  const s0 = buildExecutionState(plan, critique, new Set());
  assert(s0.state === "running", s0);
  assert(JSON.stringify(s0.dispatch_step_ids) === JSON.stringify(["step_1", "step_2", "step_3"]), s0);

  const s1 = buildExecutionState(plan, critique, new Set(["step_1"]));
  assert(JSON.stringify(s1.dispatch_step_ids) === JSON.stringify(["step_2", "step_3"]), s1);

  const s2 = buildExecutionState(plan, critique, new Set(["step_1", "step_2"]));
  assert(JSON.stringify(s2.dispatch_step_ids) === JSON.stringify(["step_3"]), s2);

  const s3 = buildExecutionState(plan, critique, new Set(["step_1", "step_2", "step_3"]));
  assert(JSON.stringify(s3.dispatch_step_ids) === JSON.stringify(["step_4"]), s3);

  console.log("PASS: parallel fan-out/fan-in executor behavior verified");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
