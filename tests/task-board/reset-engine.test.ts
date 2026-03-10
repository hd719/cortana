import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureStdout } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());
const runPsql = vi.hoisted(() => vi.fn());
const repoRoot = vi.hoisted(() => vi.fn(() => "/repo"));

vi.mock("node:child_process", () => ({
  spawnSync,
}));

vi.mock("../../tools/lib/paths.js", () => ({
  repoRoot,
}));

vi.mock("../../tools/lib/db.js", () => ({
  withPostgresPath: (env: NodeJS.ProcessEnv) => env,
  runPsql,
}));

describe("task-board reset-engine", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    runPsql.mockReset();
  });

  it("prioritizes in-progress and tomorrow-relevant tasks in the mission stack", async () => {
    const { selectTomorrowMissionTasks } = await import("../../tools/task-board/reset-engine");
    const now = new Date("2026-03-10T21:00:00-04:00");
    const tasks = [
      {
        id: 1,
        title: "Low-priority ready task",
        status: "ready",
        priority: 5,
        due_at: null,
        execute_at: null,
        created_at: "2026-03-10T09:00:00-04:00",
      },
      {
        id: 2,
        title: "Carry active implementation over the line",
        status: "in_progress",
        priority: 3,
        due_at: null,
        execute_at: null,
        created_at: "2026-03-09T09:00:00-04:00",
      },
      {
        id: 3,
        title: "Tomorrow due task",
        status: "ready",
        priority: 2,
        due_at: "2026-03-11T10:00:00-04:00",
        execute_at: null,
        created_at: "2026-03-10T08:00:00-04:00",
      },
      {
        id: 4,
        title: "Scheduled for tomorrow morning",
        status: "scheduled",
        priority: 4,
        due_at: null,
        execute_at: "2026-03-11T07:30:00-04:00",
        created_at: "2026-03-10T08:30:00-04:00",
      },
      {
        id: 5,
        title: "Already overdue",
        status: "ready",
        priority: 1,
        due_at: "2026-03-10T08:00:00-04:00",
        execute_at: null,
        created_at: "2026-03-08T08:30:00-04:00",
      },
    ];

    const selected = selectTomorrowMissionTasks(tasks as any, now);
    expect(selected.map((task) => task.id)).toEqual([2, 5, 3, 4, 1]);
  });

  it("renders a tomorrow mission stack with reset counts and MIT", async () => {
    const { renderTomorrowMissionStack } = await import("../../tools/task-board/reset-engine");
    const output = renderTomorrowMissionStack(
      [
        {
          id: 10,
          title: "Finish task-board reset engine tests",
          status: "in_progress",
          priority: 1,
          due_at: null,
          execute_at: null,
          created_at: "2026-03-10T10:00:00-04:00",
        },
        {
          id: 11,
          title: "Ship tomorrow brief cleanup",
          status: "ready",
          priority: 2,
          due_at: "2026-03-11T09:00:00-04:00",
          execute_at: null,
          created_at: "2026-03-10T11:00:00-04:00",
        },
      ] as any,
      {
        syncedCount: 2,
        reconciledCount: 1,
        staleFlaggedCount: 3,
        orphanResetCount: 1,
        scheduledPromotedCount: 2,
        staleClosedCount: 4,
      },
      new Date(2026, 2, 10, 21, 0, 0)
    );

    expect(output).toContain("Tomorrow Mission Stack - Wednesday, March 11");
    expect(output).toContain("Reset: synced 2, reconciled 1, reset 1, promoted 2, closed 4 stale.");
    expect(output).toContain("MIT: Finish task-board reset engine tests");
    expect(output).toContain("1. ⏳ Finish task-board reset engine tests");
  });

  it("runs the full reset workflow in order and emits JSON", async () => {
    const { main } = await import("../../tools/task-board/reset-engine");

    spawnSync
      .mockReturnValueOnce({ status: 0, stdout: '{"ok":true,"synced_count":2}\n', stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: '{"ok":true,"action_count":3}\n', stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout:
          '{"ok":true,"actions":{"stale_pending_flagged_count":4,"orphaned_in_progress_reset_count":1}}\n',
        stderr: "",
      });

    runPsql
      .mockReturnValueOnce({
        status: 0,
        stdout: '{"count":2,"tasks":[{"id":21},{"id":22}],"event_ids":[201,202]}\n',
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: '{"count":1,"tasks":[{"id":31}],"event_ids":[301],"policy":{"ready_age_days":14,"stale_flag_grace_days":3}}\n',
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout:
          '[{"id":101,"title":"Finish #437","status":"in_progress","priority":1,"due_at":null,"execute_at":null,"created_at":"2026-03-10T10:00:00-04:00"},{"id":102,"title":"Prepare tomorrow mission stack","status":"ready","priority":2,"due_at":"2026-03-11T09:00:00-04:00","execute_at":null,"created_at":"2026-03-10T11:00:00-04:00"}]\n',
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    const stdout = captureStdout();
    const report = main(["--json"]);
    stdout.restore();

    expect(spawnSync.mock.calls.map((call) => call[1])).toEqual([
      ["tsx", "tools/task-board/completion-sync.ts"],
      ["tsx", "tools/task-board/aggressive-reconcile.ts", "--apply"],
      ["tsx", "tools/task-board/stale-detector.ts"],
    ]);

    expect(report.summary).toMatchObject({
      syncedCount: 2,
      reconciledCount: 3,
      staleFlaggedCount: 4,
      orphanResetCount: 1,
      scheduledPromotedCount: 2,
      staleClosedCount: 1,
    });
    expect(report.mission_stack.task_ids).toEqual([101, 102]);
    expect(stdout.writes.join("")).toContain('"staleClosedCount": 1');
  });
});
