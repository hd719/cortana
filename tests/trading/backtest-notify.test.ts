import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pickPendingFromCandidates, type SummaryCandidate } from "../../tools/trading/backtest-notify";

function candidate(
  file: string,
  {
    status,
    completedAt,
    notifiedAt = null,
  }: {
    status: "success" | "failed";
    completedAt: string;
    notifiedAt?: string | null;
  },
): SummaryCandidate {
  return {
    file,
    summary: {
      schemaVersion: 1,
      runId: file,
      strategy: "Trading market-session unified",
      status,
      completedAt,
      notifiedAt,
      artifacts: {
        directory: `/tmp/${file}`,
        summary: `/tmp/${file}/summary.json`,
        log: `/tmp/${file}/run.log`,
      },
    },
  };
}

describe("backtest notify selection", () => {
  it("returns nothing when the latest completed run failed and failures are excluded", () => {
    const picked = pickPendingFromCandidates([
      candidate("failed-new", { status: "failed", completedAt: "2026-03-14T17:23:20.539Z" }),
      candidate("success-old", { status: "success", completedAt: "2026-03-13T23:31:34.666Z" }),
    ]);

    expect(picked).toBeNull();
  });

  it("returns no candidate when only failed runs are pending and failures are excluded", () => {
    const picked = pickPendingFromCandidates([
      candidate("failed-new", { status: "failed", completedAt: "2026-03-14T17:23:20.539Z" }),
    ]);

    expect(picked).toBeNull();
  });

  it("can include failed runs when explicitly requested", () => {
    const picked = pickPendingFromCandidates(
      [
        candidate("failed-new", { status: "failed", completedAt: "2026-03-14T17:23:20.539Z" }),
        candidate("success-old", { status: "success", completedAt: "2026-03-13T23:31:34.666Z" }),
      ],
      { includeFailures: true },
    );

    expect(picked?.summary.runId).toBe("failed-new");
  });

  it("ignores already-notified runs", () => {
    const picked = pickPendingFromCandidates([
      candidate("success-notified", {
        status: "success",
        completedAt: "2026-03-14T17:23:20.539Z",
        notifiedAt: "2026-03-14T17:25:53.290Z",
      }),
      candidate("success-pending", { status: "success", completedAt: "2026-03-13T23:31:34.666Z" }),
    ]);

    expect(picked).toBeNull();
  });

  it("selects the latest completed run when it is pending and successful", () => {
    const picked = pickPendingFromCandidates([
      candidate("success-old", { status: "success", completedAt: "2026-03-13T23:31:34.666Z" }),
      candidate("success-new", { status: "success", completedAt: "2026-03-14T17:23:20.539Z" }),
    ]);

    expect(picked?.summary.runId).toBe("success-new");
  });

  it("does not fall back to older pending successes when the latest run is already notified", () => {
    const picked = pickPendingFromCandidates([
      candidate("success-old", { status: "success", completedAt: "2026-03-13T23:31:34.666Z" }),
      candidate("success-new", {
        status: "success",
        completedAt: "2026-03-14T17:23:20.539Z",
        notifiedAt: "2026-03-14T17:25:53.290Z",
      }),
    ]);

    expect(picked).toBeNull();
  });
});

describe("backtest notify delivery contract", () => {
  function setupRun(root: string, runId: string): string {
    const runDir = path.join(root, "runs", runId);
    const summaryPath = path.join(runDir, "summary.json");
    const messagePath = path.join(runDir, "message.txt");

    mkdirSync(runDir, { recursive: true });
    const summary = {
      schemaVersion: 1,
      runId,
      strategy: "Trading market-session unified",
      status: "success",
      completedAt: "2026-01-01T00:00:00.000Z",
      notifiedAt: null,
      artifacts: {
        directory: runDir,
        summary: summaryPath,
        log: path.join(runDir, "run.log"),
        message: messagePath,
      },
    };

    writeFileSync(messagePath, "hello\n");
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    return summaryPath;
  }

  it("stamps notified when guard confirms sent", () => {
    const root = mkdtempSync(path.join(process.cwd(), "tmp-notify-"));
    const notifyStub = path.join(root, "notify-stub.sh");
    const summaryPath = setupRun(root, "20260101-000000");

    writeFileSync(
      notifyStub,
      "#!/usr/bin/env bash\nprintf '{\"delivered\":true,\"mode\":\"sent\"}\\n'\nexit 0\n",
      { mode: 0o755 },
    );

    execSync(`BACKTEST_ROOT_DIR=${root} BACKTEST_NOTIFY_BIN=${notifyStub} node --import tsx ./tools/trading/backtest-notify.ts`, {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const updated = JSON.parse(readFileSync(summaryPath, "utf8"));
    expect(updated.notifiedAt).not.toBeNull();
  });

  it("does not stamp notified when guard returns deduped/suppressed", () => {
    const root = mkdtempSync(path.join(process.cwd(), "tmp-notify-"));
    const notifyStub = path.join(root, "notify-stub.sh");
    const summaryPath = setupRun(root, "20260101-000001");

    writeFileSync(
      notifyStub,
      "#!/usr/bin/env bash\nprintf '{\"delivered\":false,\"mode\":\"deduped\"}\\n'\nexit 0\n",
      { mode: 0o755 },
    );

    execSync(`BACKTEST_ROOT_DIR=${root} BACKTEST_NOTIFY_BIN=${notifyStub} node --import tsx ./tools/trading/backtest-notify.ts`, {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const updated = JSON.parse(readFileSync(summaryPath, "utf8"));
    expect(updated.notifiedAt).toBeNull();
  });

  it("fails when guard fails delivery", () => {
    const root = mkdtempSync(path.join(process.cwd(), "tmp-notify-"));
    const notifyStub = path.join(root, "notify-stub.sh");
    const summaryPath = setupRun(root, "20260101-000002");

    writeFileSync(notifyStub, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

    let exitCode = 0;
    try {
      execSync(`BACKTEST_ROOT_DIR=${root} BACKTEST_NOTIFY_BIN=${notifyStub} node --import tsx ./tools/trading/backtest-notify.ts`, {
        cwd: process.cwd(),
        stdio: "pipe",
      });
    } catch (error: any) {
      exitCode = error?.status ?? 1;
    }

    const updated = JSON.parse(readFileSync(summaryPath, "utf8"));
    expect(exitCode).not.toBe(0);
    expect(updated.notifiedAt).toBeNull();
  });
});
