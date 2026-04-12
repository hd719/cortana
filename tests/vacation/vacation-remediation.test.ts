import { describe, expect, it } from "vitest";
import { loadVacationOpsConfig } from "../../tools/vacation/vacation-config.ts";
import { runRemediationPlan } from "../../tools/vacation/vacation-remediation.ts";

const config = loadVacationOpsConfig();

describe("vacation remediation", () => {
  it("halts the ladder once verification succeeds", () => {
    const calls: string[] = [];
    const result = runRemediationPlan({
      config,
      systemKey: "mission_control",
      initialCheck: { system_key: "mission_control", tier: 0, status: "red", observed_at: "2026-04-11T12:00:00.000Z", detail: {} },
      checkRunner: () => {
        calls.push("check");
        return { system_key: "mission_control", tier: 0, status: calls.length >= 1 ? "green" : "red", observed_at: "2026-04-11T12:01:00.000Z", detail: {} };
      },
      vacationWindowId: 1,
      runId: 2,
      env: {
        spawn: (() => ({ status: 0, stdout: "ok", stderr: "" })) as any,
      },
    });
    expect(result.finalState).toBe("resolved");
    expect(result.actions.length).toBeGreaterThan(0);
  });

  it("stops immediately for interactive-auth-required failures", () => {
    const result = runRemediationPlan({
      config,
      systemKey: "gog_headless_auth",
      initialCheck: {
        system_key: "gog_headless_auth",
        tier: 1,
        status: "red",
        observed_at: "2026-04-11T12:00:00.000Z",
        detail: { error: "Manual reauth required: token expired" },
      },
      checkRunner: () => ({ system_key: "gog_headless_auth", tier: 1, status: "red", observed_at: "2026-04-11T12:00:00.000Z", detail: {} }),
      vacationWindowId: 1,
      runId: 2,
    });
    expect(result.finalState).toBe("human_required");
    expect(result.actions).toEqual([]);
  });
});
