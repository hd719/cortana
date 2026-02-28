#!/usr/bin/env npx tsx

/** Executor policy engine for Covenant orchestration v2. */

import fs from "fs";
import path from "path";

const HARD_ESCALATE_FAILURES = new Set(["auth_failure", "permission_denied", "requirements_ambiguous"]);
const TRANSIENT_FAILURES = new Set(["transient_tool_failure", "network_timeout", "timeout"]);

const ROUTE_SUGGESTION: Record<string, string | undefined> = {
  "agent.researcher.v1": "agent.oracle.v1",
  "agent.oracle.v1": "agent.librarian.v1",
  "agent.monitor.v1": "agent.huragok.v1",
  "agent.huragok.v1": "agent.monitor.v1",
  "agent.librarian.v1": "agent.huragok.v1",
};

type Json = Record<string, unknown>;

function stepIndex(plan: Json): Record<string, Json> {
  const steps = plan.steps;
  if (!Array.isArray(steps)) return {};
  const out: Record<string, Json> = {};
  for (const step of steps) {
    if (step && typeof step === "object") {
      const stepObj = step as Json;
      if (typeof stepObj.step_id === "string") {
        out[stepObj.step_id] = stepObj;
      }
    }
  }
  return out;
}

function parallelGroups(plan: Json): Record<string, Set<string>> {
  const groups: Record<string, Set<string>> = {};
  const steps = plan.steps;
  if (!Array.isArray(steps)) return groups;

  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const stepObj = step as Json;
    const sid = stepObj.step_id;
    const grp = stepObj.parallel_group;
    if (typeof sid === "string" && typeof grp === "string" && grp.trim()) {
      const key = grp.trim();
      if (!groups[key]) groups[key] = new Set();
      groups[key].add(sid);
    }
  }
  return groups;
}

export function groupForStep(plan: Json, stepId: string): string | null {
  const step = stepIndex(plan)[stepId];
  const grp = step ? step.parallel_group : null;
  if (typeof grp === "string" && grp.trim()) return grp.trim();
  return null;
}

export function groupIsComplete(plan: Json, parallelGroup: string, completedSteps: Set<string>): boolean {
  const groups = parallelGroups(plan);
  const members = groups[parallelGroup] ?? new Set<string>();
  return members.size > 0 && Array.from(members).every((m) => completedSteps.has(m));
}

function expandedDependencies(plan: Json, step: Json): Set<string> {
  const depsRaw = step.depends_on;
  const deps = Array.isArray(depsRaw) ? depsRaw.filter((d) => typeof d === "string") : [];
  const idx = stepIndex(plan);
  const groups = parallelGroups(plan);
  const expanded = new Set<string>(deps as string[]);

  for (const dep of deps as string[]) {
    const depStep = idx[dep];
    const grp = depStep ? depStep.parallel_group : null;
    if (typeof grp === "string" && grp.trim() && groups[grp.trim()]) {
      for (const member of groups[grp.trim()]) {
        expanded.add(member);
      }
    }
  }
  return expanded;
}

export function nextReadySteps(plan: Json, completedSteps: Set<string>): Json[] {
  const stepsRaw = plan.steps;
  const steps = Array.isArray(stepsRaw) ? stepsRaw.filter((s) => s && typeof s === "object") : [];
  const idx = stepIndex(plan);

  for (const step of steps) {
    const stepObj = step as Json;
    const sid = stepObj.step_id;
    if (typeof sid !== "string" || completedSteps.has(sid)) continue;

    const deps = expandedDependencies(plan, stepObj);
    let ready = true;
    for (const dep of deps) {
      if (!completedSteps.has(dep)) {
        ready = false;
        break;
      }
    }
    if (!ready) continue;

    const grp = stepObj.parallel_group;
    if (typeof grp === "string" && grp.trim()) {
      const groupName = grp.trim();
      const readyMembers: Json[] = [];
      for (const [memberId, member] of Object.entries(idx)) {
        const memberGroup = member.parallel_group;
        if (completedSteps.has(memberId)) continue;
        if (!(typeof memberGroup === "string" && memberGroup.trim() === groupName)) continue;
        const memberDeps = expandedDependencies(plan, member);
        let memberReady = true;
        for (const dep of memberDeps) {
          if (!completedSteps.has(dep)) {
            memberReady = false;
            break;
          }
        }
        if (memberReady) readyMembers.push(member);
      }
      if (readyMembers.length) return readyMembers;
    }

    return [stepObj];
  }

  return [];
}

export function nextReadyStep(plan: Json, completedSteps: Set<string>): Json | null {
  const ready = nextReadySteps(plan, completedSteps);
  return ready.length ? ready[0] : null;
}

export function decideRetry(agentIdentityId: string, failureType: string, attempt: number, maxRetries: number): Json {
  const failure = failureType.trim().toLowerCase();

  if (HARD_ESCALATE_FAILURES.has(failure)) {
    return {
      action: "escalate_immediately",
      route_to: null,
      reason: "Hard-blocking failure class; retries are unsafe by policy.",
    };
  }

  if (TRANSIENT_FAILURES.has(failure) && attempt <= maxRetries) {
    return {
      action: "retry_same_agent",
      route_to: agentIdentityId,
      reason: "Transient/timeout failure within retry budget.",
    };
  }

  return {
    action: "escalate_with_route_suggestion",
    route_to: ROUTE_SUGGESTION[agentIdentityId],
    reason: "Failure exceeded retry budget or non-transient class.",
  };
}

export function buildExecutionState(
  plan: Json,
  critique: Json,
  completedSteps: Set<string> | null = null,
  failureEvent: Json | null = null
): Json {
  const completed = completedSteps ?? new Set<string>();

  if (!critique.approved) {
    return {
      state: "blocked",
      current_step_id: null,
      dispatch_step_ids: [],
      next_action: "replan_or_human_review",
      retry_decision: {
        action: "none",
        route_to: null,
        reason: "Arbiter rejected plan; execution halted before dispatch.",
      },
    };
  }

  if (failureEvent) {
    const retry = decideRetry(
      String(failureEvent.agent_identity_id ?? ""),
      String(failureEvent.failure_type ?? ""),
      Number(failureEvent.attempt ?? 0),
      Number(failureEvent.max_retries ?? 0)
    );
    return {
      state: String(retry.action).startsWith("escalate") ? "blocked" : "running",
      current_step_id: failureEvent.step_id ?? null,
      dispatch_step_ids: failureEvent.step_id ? [failureEvent.step_id] : [],
      next_action: retry.action,
      retry_decision: retry,
    };
  }

  const readySteps = nextReadySteps(plan, completed);
  if (!readySteps.length) {
    return {
      state: "completed",
      current_step_id: null,
      dispatch_step_ids: [],
      next_action: "final_quality_gate",
      retry_decision: { action: "none", route_to: null, reason: "All steps complete." },
    };
  }

  const dispatchIds = readySteps
    .map((s) => s.step_id)
    .filter((id) => typeof id === "string") as string[];

  return {
    state: "running",
    current_step_id: dispatchIds[0] ?? null,
    dispatch_step_ids: dispatchIds,
    next_action: "dispatch_step",
    retry_decision: { action: "none", route_to: null, reason: "No failure event." },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: executor.ts <plan.json> <critique.json> [--completed <completed.json>] [--failure <failure.json>]");
    process.exit(2);
  }

  const plan = JSON.parse(fs.readFileSync(path.resolve(args[0]), "utf8"));
  const critique = JSON.parse(fs.readFileSync(path.resolve(args[1]), "utf8"));

  let completed: Set<string> = new Set();
  const completedIndex = args.indexOf("--completed");
  if (completedIndex !== -1 && args[completedIndex + 1]) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(args[completedIndex + 1]), "utf8"));
    if (Array.isArray(raw)) {
      completed = new Set(raw.map((x) => String(x)));
    }
  }

  let failure: Json | null = null;
  const failureIndex = args.indexOf("--failure");
  if (failureIndex !== -1 && args[failureIndex + 1]) {
    failure = JSON.parse(fs.readFileSync(path.resolve(args[failureIndex + 1]), "utf8"));
  }

  const result = buildExecutionState(plan, critique, completed, failure);
  console.log(JSON.stringify(result, null, 2));
}

main();
