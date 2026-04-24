import { describe, expect, it } from "vitest";
import { buildTransitionEvent, classifyTerminalOutcome, normalizeAssignedAgent } from "../../tools/task-board/lifecycle.ts";

describe("task-board lifecycle boundary", () => {
  it("maps terminal session statuses to task outcomes", () => {
    expect(classifyTerminalOutcome({ status: "ok" })).toEqual({ outcome: "completed", lifecycleEvent: "completed" });
    expect(classifyTerminalOutcome({ status: "timeout" })).toEqual({ outcome: "failed", lifecycleEvent: "timeout" });
    expect(classifyTerminalOutcome({ lastStatus: "cancelled" })).toEqual({ outcome: "failed", lifecycleEvent: "killed" });
    expect(classifyTerminalOutcome({ abortedLastRun: true })).toEqual({ outcome: "failed", lifecycleEvent: "killed" });
    expect(classifyTerminalOutcome({ status: "running" })).toBeNull();
  });

  it("builds auditable transition events", () => {
    const event = buildTransitionEvent({ taskId: 42, from: "ready", to: "in_progress", actor: "huragok", runId: "run-1" });
    expect(event).toMatchObject({ eventType: "task_state_transition", severity: "info" });
    expect(event.metadata).toMatchObject({ task_id: 42, previous_status: "ready", result_status: "in_progress", run_id: "run-1", ok: true });
  });

  it("normalizes empty agent labels", () => {
    expect(normalizeAssignedAgent(" huragok ")).toBe("huragok");
    expect(normalizeAssignedAgent("undefined")).toBeNull();
    expect(normalizeAssignedAgent("")).toBeNull();
  });
});
