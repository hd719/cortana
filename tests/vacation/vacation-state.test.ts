import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runPsql = vi.hoisted(() => vi.fn());

vi.mock("../../tools/lib/db.ts", () => ({
  runPsql,
}));

describe("vacation state", () => {
  beforeEach(() => {
    runPsql.mockReset();
  });

  it("ignores corrupted runtime mirrors", async () => {
    const mod = await import("../../tools/vacation/vacation-state.ts");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vacation-mirror-"));
    const mirrorPath = path.join(tempDir, "vacation-mode.json");
    fs.writeFileSync(mirrorPath, "{not-json", "utf8");

    expect(mod.readVacationMirror(mirrorPath)).toBeNull();
  });

  it("writes a fresh runtime mirror from canonical active-window state", async () => {
    const activeWindow = {
      id: 42,
      label: "vacation-2026-04-20",
      status: "active",
      timezone: "America/New_York",
      start_at: "2026-04-20T12:00:00.000Z",
      end_at: "2026-04-30T12:00:00.000Z",
      trigger_source: "manual_command",
      created_by: "hamel",
      config_snapshot: {},
      state_snapshot: { paused_job_ids: ["af9e1570-3ba2-4d10-a807-91cdfc2df18b"] },
      created_at: "2026-04-10T12:00:00.000Z",
      updated_at: "2026-04-10T12:00:00.000Z",
    };
    const latestRun = {
      id: 99,
      vacation_window_id: 42,
      run_type: "readiness",
      trigger_source: "manual_command",
      dry_run: false,
      summary_payload: {},
      summary_text: "",
      started_at: "2026-04-10T12:00:00.000Z",
      state: "completed",
    };

    runPsql
      .mockReturnValueOnce({ status: 0, stdout: `${JSON.stringify(activeWindow)}\n`, stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: `${JSON.stringify(latestRun)}\n`, stderr: "" });

    const mod = await import("../../tools/vacation/vacation-state.ts");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vacation-mirror-"));
    const mirrorPath = path.join(tempDir, "vacation-mode.json");
    const mirror = mod.reconcileVacationMirror(mirrorPath);

    expect(mirror?.enabled).toBe(true);
    expect(mirror?.windowId).toBe(42);
    expect(mirror?.latestReadinessRunId).toBe(99);
    expect(JSON.parse(fs.readFileSync(mirrorPath, "utf8")).pausedJobIds).toEqual(["af9e1570-3ba2-4d10-a807-91cdfc2df18b"]);
  });

  it("only flips requested runtime jobs when pausing or restoring", async () => {
    const mod = await import("../../tools/vacation/vacation-state.ts");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vacation-cron-"));
    const runtimeFile = path.join(tempDir, "jobs.json");
    fs.writeFileSync(
      runtimeFile,
      JSON.stringify({
        jobs: [
          { id: "a", enabled: true, updatedAtMs: 1 },
          { id: "b", enabled: true, updatedAtMs: 2 },
        ],
      }),
      "utf8",
    );

    const paused = mod.setRuntimeCronJobsEnabled(["b"], false, runtimeFile);
    expect(paused).toEqual(["b"]);
    const updated = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    expect(updated.jobs[0].enabled).toBe(true);
    expect(updated.jobs[1].enabled).toBe(false);
  });

  it("updates an existing incident when resolving instead of inserting duplicates", async () => {
    runPsql.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const mod = await import("../../tools/vacation/vacation-state.ts");

    mod.upsertVacationIncident({
      vacationWindowId: 42,
      runId: 9,
      systemKey: "market_scans",
      tier: 2,
      status: "resolved",
      humanRequired: false,
      observedAt: "2026-04-11T12:30:00.000Z",
      resolutionReason: "healthy",
      detail: { status: "green" },
    });

    const sql = String(runPsql.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("WITH existing AS");
    expect(sql).toContain("UPDATE cortana_vacation_incidents");
    expect(sql).toContain("ORDER BY CASE WHEN status IN ('open', 'degraded', 'human_required') THEN 0 ELSE 1 END");
    expect(sql).not.toContain("ON CONFLICT");
  });
});
