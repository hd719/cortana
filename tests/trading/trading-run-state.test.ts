import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const { runPsqlMock } = vi.hoisted(() => ({
  runPsqlMock: vi.fn(),
}));

vi.mock("../../tools/lib/db", () => ({
  runPsql: runPsqlMock,
  withPostgresPath: (env: NodeJS.ProcessEnv) => env,
}));

import {
  buildTradingRunStateRecordFromArtifacts,
  buildTradingRunUpsertSql,
  syncTradingRunFromArtifacts,
  syncTradingRunStarted,
} from "../../tools/trading/trading-run-state";

function setupRunArtifacts(root: string, runId: string) {
  const runDir = path.join(root, runId);
  const summaryPath = path.join(runDir, "summary.json");
  const messagePath = path.join(runDir, "message.txt");
  const watchlistPath = path.join(runDir, "watchlist-full.json");
  const stderrPath = path.join(runDir, "stderr.txt");

  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    summaryPath,
    JSON.stringify({
      schemaVersion: 1,
      runId,
      strategy: "Trading market-session unified",
      status: "success",
      createdAt: "2026-04-07T17:19:40.000Z",
      startedAt: "2026-04-07T17:19:40.000Z",
      completedAt: "2026-04-07T17:29:03.000Z",
      notifiedAt: "2026-04-07T17:29:13.000Z",
      host: "test-host",
      metrics: {
        decision: "NO_TRADE",
        confidence: 0.9,
        risk: "LOW",
        buy: 0,
        watch: 0,
        noBuy: 96,
        symbolsScanned: 240,
        candidatesEvaluated: 96,
      },
      artifacts: {
        directory: runDir,
        summary: summaryPath,
        stderr: stderrPath,
        message: messagePath,
        watchlistFullJson: watchlistPath,
      },
    }, null, 2),
  );
  writeFileSync(
    watchlistPath,
    JSON.stringify({
      decision: "NO_TRADE",
      correctionMode: false,
      summary: { buy: 0, watch: 0, noBuy: 96 },
      focus: { ticker: "AXON", action: "WATCH", strategy: "Dip Buyer" },
      strategies: {
        dipBuyer: {
          buy: [],
          watch: [{ ticker: "AXON" }],
          noBuy: [{ ticker: "AAPL" }],
        },
        canslim: {
          buy: [],
          watch: [],
          noBuy: [{ ticker: "MSFT" }],
        },
      },
    }, null, 2),
  );
  writeFileSync(messagePath, "Trading Advisor\nNO_TRADE\n");
  writeFileSync(stderrPath, "");
  return { runDir, summaryPath, messagePath, watchlistPath };
}

describe("trading run state writer", () => {
  beforeEach(() => {
    runPsqlMock.mockReset();
    runPsqlMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  });

  it("builds a normalized record from run artifacts", () => {
    const root = mkdtempSync(path.join(process.cwd(), "tmp-trading-run-state-"));
    const { summaryPath } = setupRunArtifacts(root, "20260407-171940");

    const record = buildTradingRunStateRecordFromArtifacts(summaryPath);

    expect(record).toMatchObject({
      runId: "20260407-171940",
      status: "success",
      deliveryStatus: "notified",
      decision: "NO_TRADE",
      buyCount: 0,
      watchCount: 0,
      noBuyCount: 96,
      focusTicker: "AXON",
      focusAction: "WATCH",
      focusStrategy: "Dip Buyer",
      dipBuyerWatch: ["AXON"],
      canslimNoBuy: ["MSFT"],
      sourceHost: "test-host",
    });
  });

  it("writes an upsert through MISSION_CONTROL_DATABASE_URL", () => {
    const root = mkdtempSync(path.join(process.cwd(), "tmp-trading-run-state-"));
    const { summaryPath } = setupRunArtifacts(root, "20260407-171941");

    const result = syncTradingRunFromArtifacts(summaryPath, {
      env: { ...process.env, MISSION_CONTROL_DATABASE_URL: "postgresql://writer@localhost:5432/mission_control" },
    });

    expect(result).toEqual({ ok: true, mode: "written" });
    expect(runPsqlMock).toHaveBeenCalledTimes(1);
    expect(runPsqlMock.mock.calls[0][1]).toMatchObject({
      db: "postgresql://writer@localhost:5432/mission_control",
    });
    expect(String(runPsqlMock.mock.calls[0][0])).toContain("INSERT INTO mc_trading_runs");
    expect(String(runPsqlMock.mock.calls[0][0])).toContain("'20260407-171941'");
    expect(String(runPsqlMock.mock.calls[0][0])).toContain("'notified'");
  });

  it("strips Prisma-only query params before invoking psql", () => {
    const root = mkdtempSync(path.join(process.cwd(), "tmp-trading-run-state-"));
    const { summaryPath } = setupRunArtifacts(root, "20260407-171945");

    const result = syncTradingRunFromArtifacts(summaryPath, {
      env: {
        ...process.env,
        MISSION_CONTROL_DATABASE_URL:
          "postgresql://writer@localhost:5432/mission_control?connection_limit=10&pool_timeout=20&sslmode=disable",
      },
    });

    expect(result).toEqual({ ok: true, mode: "written" });
    expect(runPsqlMock).toHaveBeenCalledTimes(1);
    expect(runPsqlMock.mock.calls[0][1]).toMatchObject({
      db: "postgresql://writer@localhost:5432/mission_control?sslmode=disable",
      env: expect.objectContaining({
        DATABASE_URL: "postgresql://writer@localhost:5432/mission_control?sslmode=disable",
      }),
    });
  });

  it("falls back to Mission Control .env.local when explicit sync env is missing", () => {
    const root = mkdtempSync(path.join(process.cwd(), "tmp-trading-run-state-"));
    const externalRoot = mkdtempSync(path.join(process.cwd(), "tmp-cortana-external-"));
    const envLocalPath = path.join(externalRoot, "apps", "mission-control", ".env.local");
    const { summaryPath } = setupRunArtifacts(root, "20260407-171944");

    mkdirSync(path.dirname(envLocalPath), { recursive: true });
    writeFileSync(envLocalPath, "DATABASE_URL=postgresql://writer@localhost:5432/mission_control\n");

    const result = syncTradingRunFromArtifacts(summaryPath, {
      env: { ...process.env, CORTANA_EXTERNAL_REPO: externalRoot, MISSION_CONTROL_DATABASE_URL: "" },
    });

    expect(result).toEqual({ ok: true, mode: "written" });
    expect(runPsqlMock).toHaveBeenCalledTimes(1);
    expect(runPsqlMock.mock.calls[0][1]).toMatchObject({
      db: "postgresql://writer@localhost:5432/mission_control",
    });
  });

  it("sanitizes fallback Mission Control .env.local URLs for psql", () => {
    const root = mkdtempSync(path.join(process.cwd(), "tmp-trading-run-state-"));
    const externalRoot = mkdtempSync(path.join(process.cwd(), "tmp-cortana-external-"));
    const envLocalPath = path.join(externalRoot, "apps", "mission-control", ".env.local");
    const { summaryPath } = setupRunArtifacts(root, "20260407-171946");

    mkdirSync(path.dirname(envLocalPath), { recursive: true });
    writeFileSync(
      envLocalPath,
      "DATABASE_URL=postgresql://writer@localhost:5432/mission_control?connection_limit=10&pool_timeout=20&sslmode=disable\n",
    );

    const result = syncTradingRunFromArtifacts(summaryPath, {
      env: { ...process.env, CORTANA_EXTERNAL_REPO: externalRoot, MISSION_CONTROL_DATABASE_URL: "" },
    });

    expect(result).toEqual({ ok: true, mode: "written" });
    expect(runPsqlMock).toHaveBeenCalledTimes(1);
    expect(runPsqlMock.mock.calls[0][1]).toMatchObject({
      db: "postgresql://writer@localhost:5432/mission_control?sslmode=disable",
      env: expect.objectContaining({
        DATABASE_URL: "postgresql://writer@localhost:5432/mission_control?sslmode=disable",
      }),
    });
  });

  it("skips cleanly when Mission Control DB is not configured", () => {
    const missingExternalRoot = path.join(process.cwd(), "tmp-cortana-external-missing");
    const result = syncTradingRunStarted({
      runId: "20260407-171942",
      strategy: "Trading market-session unified",
      createdAt: "2026-04-07T17:19:42.000Z",
      artifactDirectory: "/tmp/run",
      summaryPath: "/tmp/run/summary.json",
      messagePath: "/tmp/run/message.txt",
      watchlistPath: "/tmp/run/watchlist-full.json",
    }, { env: { CORTANA_EXTERNAL_REPO: missingExternalRoot } });

    expect(result).toEqual({
      ok: false,
      mode: "skipped",
      reason: "MISSION_CONTROL_DATABASE_URL is not configured",
    });
    expect(runPsqlMock).not.toHaveBeenCalled();
  });

  it("renders a stable SQL upsert for direct producer writes", () => {
    const sql = buildTradingRunUpsertSql({
      id: "20260407-171943",
      runId: "20260407-171943",
      schemaVersion: 1,
      strategy: "Trading market-session unified",
      status: "running",
      createdAt: "2026-04-07T17:19:43.000Z",
      startedAt: "2026-04-07T17:19:43.000Z",
      completedAt: null,
      notifiedAt: null,
      deliveryStatus: "pending",
      decision: null,
      confidence: null,
      risk: null,
      correctionMode: null,
      buyCount: null,
      watchCount: null,
      noBuyCount: null,
      symbolsScanned: null,
      candidatesEvaluated: null,
      focusTicker: null,
      focusAction: null,
      focusStrategy: null,
      dipBuyerBuy: [],
      dipBuyerWatch: [],
      dipBuyerNoBuy: [],
      canslimBuy: [],
      canslimWatch: [],
      canslimNoBuy: [],
      artifactDirectory: "/tmp/run",
      summaryPath: "/tmp/run/summary.json",
      messagePath: "/tmp/run/message.txt",
      watchlistPath: "/tmp/run/watchlist-full.json",
      messagePreview: null,
      metrics: null,
      lastError: null,
      sourceHost: "test-host",
    });

    expect(sql).toContain("ON CONFLICT (\"run_id\") DO UPDATE");
    expect(sql).toContain("\"status\" = EXCLUDED.\"status\"");
    expect(sql).toContain("\"updated_at\" = CURRENT_TIMESTAMP");
  });
});
