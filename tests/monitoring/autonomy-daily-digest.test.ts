import { beforeEach, describe, expect, it, vi } from "vitest";

const buildAutonomyOpsSummary = vi.hoisted(() => vi.fn());
const collectAutonomyStatus = vi.hoisted(() => vi.fn());

vi.mock("../../tools/monitoring/autonomy-ops.ts", () => ({ buildAutonomyOpsSummary }));
vi.mock("../../tools/monitoring/autonomy-status.ts", () => ({ collectAutonomyStatus }));

describe("autonomy-daily-digest", () => {
  beforeEach(() => {
    buildAutonomyOpsSummary.mockReset();
    collectAutonomyStatus.mockReset();
  });

  it("renders a concise executive digest from the operator surface", async () => {
    buildAutonomyOpsSummary.mockReturnValue({
      operatorState: "watch",
      autoFixed: ["gateway"],
      degraded: ["channel:escalate"],
      waitingOnHamel: ["1 escalated check(s)"],
      blocked: ["repo_handoff:completed branch work exists without PR or blocker report"],
      familyCritical: { tracked: ["family_critical"], failures: 0 },
      counts: { suppressed: 3 },
    });
    collectAutonomyStatus.mockReturnValue({
      failedRecoveredItems: ["gateway", "cron"],
      scorecard: {
        counts: { autoFixAttempted: 4, autoFixSucceeded: 2, escalations: 1, blockedOrExceededAuthority: 1, staleReportSuppressions: 3 },
        activeFollowUps: [{ system: "channel", taskId: 12 }],
      },
    });

    const { buildDailyDigest } = await import("../../tools/monitoring/autonomy-daily-digest.ts");
    const digest = buildDailyDigest(new Date("2026-03-11T12:00:00Z"));

    expect(digest.digest).toContain("📘 Autonomy - Daily Executive Digest (2026-03-11)");
    expect(digest.digest).toContain("State: watch");
    expect(digest.digest).toContain("Auto-fixed: gateway");
    expect(digest.digest).toContain("Recovered after degradation: gateway, cron");
    expect(digest.digest).toContain("Needs Hamel: 1 escalated check(s)");
    expect(digest.digest).toContain("Blocked / exceeded authority: repo_handoff:completed branch work exists without PR or blocker report");
    expect(digest.digest).toContain("Family-critical: tracked 1, failures 0");
    expect(digest.digest).toContain("Noise suppressed: 3");
  });
});
