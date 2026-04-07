import { beforeEach, describe, expect, it, vi } from "vitest";

const { runPsqlMock, spawnSyncMock } = vi.hoisted(() => ({
  runPsqlMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock("../../tools/lib/db", () => ({
  runPsql: runPsqlMock,
  withPostgresPath: (env: NodeJS.ProcessEnv) => env,
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import { reportMissionControlIncident, reportTradingRunSyncIncident } from "../../tools/trading/trading-ops-guard";

describe("trading ops guard", () => {
  beforeEach(() => {
    runPsqlMock.mockReset();
    spawnSyncMock.mockReset();
    runPsqlMock.mockReturnValue({ status: 0 });
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  });

  it("logs and alerts trading-run sync failures", () => {
    reportTradingRunSyncIncident({
      runId: "20260407-184119",
      stage: "finalize",
      mode: "failed",
      reason: "psql: connection refused",
      env: process.env,
    });

    expect(runPsqlMock).toHaveBeenCalledTimes(1);
    expect(String(runPsqlMock.mock.calls[0][0])).toContain("trading_ops_guardrail");
    expect(String(runPsqlMock.mock.calls[0][0])).toContain("run_id=20260407-184119");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0][1]).toContain("trading_ops_guardrail");
    expect(spawnSyncMock.mock.calls[0][1]).toContain("trading_ops_sync:sync_failed");
  });

  it("classifies missing Mission Control DB config separately", () => {
    reportTradingRunSyncIncident({
      runId: "20260407-184120",
      stage: "start",
      mode: "skipped",
      reason: "MISSION_CONTROL_DATABASE_URL is not configured",
      env: process.env,
    });

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0][1]).toContain("trading_ops_sync:mission_control_db_missing");
  });

  it("logs and alerts Mission Control incidents", () => {
    reportMissionControlIncident({
      kind: "smoke_failed",
      message: "Trading Ops smoke failed after Mission Control restart.",
      detail: "Latest run card fell back to file artifacts.",
      env: process.env,
    });

    expect(runPsqlMock).toHaveBeenCalledTimes(1);
    expect(String(runPsqlMock.mock.calls[0][0])).toContain("Trading Ops smoke failed after Mission Control restart.");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0][1]).toContain("mission_control:smoke_failed");
  });
});
