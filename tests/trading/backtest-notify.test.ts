import { describe, expect, it } from "vitest";
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
