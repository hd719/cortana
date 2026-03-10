import { describe, expect, it } from "vitest";
import { classifyTerminalOutcome } from "../../tools/task-board/completion-sync.ts";

describe("classifyTerminalOutcome", () => {
  it("maps successful terminal states to completed", () => {
    expect(classifyTerminalOutcome({ status: "completed" })).toEqual({ outcome: "completed", lifecycleEvent: "completed" });
    expect(classifyTerminalOutcome({ lastStatus: "success" })).toEqual({ outcome: "completed", lifecycleEvent: "completed" });
  });

  it("maps failure-like states to failed with the right lifecycle event", () => {
    expect(classifyTerminalOutcome({ status: "timeout" })).toEqual({ outcome: "failed", lifecycleEvent: "timeout" });
    expect(classifyTerminalOutcome({ status: "killed" })).toEqual({ outcome: "failed", lifecycleEvent: "killed" });
    expect(classifyTerminalOutcome({ status: "error" })).toEqual({ outcome: "failed", lifecycleEvent: "failed" });
  });

  it("treats abortedLastRun as killed even without explicit status", () => {
    expect(classifyTerminalOutcome({ status: "unknown", abortedLastRun: true })).toEqual({ outcome: "failed", lifecycleEvent: "killed" });
  });

  it("ignores non-terminal states", () => {
    expect(classifyTerminalOutcome({ status: "running" })).toBeNull();
    expect(classifyTerminalOutcome({ status: "pending" })).toBeNull();
  });
});
