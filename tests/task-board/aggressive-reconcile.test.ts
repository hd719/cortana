import { describe, expect, it } from "vitest";
import { pickActions } from "../../tools/task-board/aggressive-reconcile";

describe("aggressive-reconcile", () => {
  it("reverts failed task to ready when retry/manual fallback marker is present", () => {
    const actions = pickActions(
      [
        {
          id: 99,
          title: "retry me",
          status: "failed",
          assigned_to: null,
          run_id: null,
          outcome: "manual fallback requested",
          metadata: { manual_retry_requested: true },
        } as any,
      ],
      []
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]?.taskId).toBe(99);
    expect(actions[0]?.action).toBe("revert_failed_to_ready");
    expect(actions[0]?.reason).toContain("Retry/manual fallback marker");
  });

  it("does not revert failed task when active run exists", () => {
    const actions = pickActions(
      [
        {
          id: 100,
          title: "still running",
          status: "failed",
          assigned_to: "agent:huragok:subagent:abc",
          run_id: null,
          outcome: "retry pending",
          metadata: { retry_pending: true, subagent_session_key: "agent:huragok:subagent:abc" },
        } as any,
      ],
      [{ key: "agent:huragok:subagent:abc", status: "running" } as any]
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe("mark_in_progress");
  });
});
