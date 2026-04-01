import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, mockExit, resetProcess, setArgv, importFresh } from "../test-utils";

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
const spawnSync = vi.hoisted(() => vi.fn());
const upsertOpenIncident = vi.hoisted(() => vi.fn());
const resolveIncident = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({ default: fsMock, ...fsMock }));
vi.mock("node:child_process", () => ({ spawnSync }));
vi.mock("../../tools/monitoring/autonomy-incidents.ts", () => ({
  upsertOpenIncident,
  resolveIncident,
}));

describe("autonomy family-critical failover", () => {
  beforeEach(() => {
    fsMock.readFileSync.mockReset();
    fsMock.writeFileSync.mockReset();
    spawnSync.mockReset();
    upsertOpenIncident.mockReset();
    resolveIncident.mockReset();
    resetProcess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  it("escalates family-critical cron failure after one bounded retry with explicit escalation path", async () => {
    const exitSpy = mockExit();
    const consoleSpy = captureConsole();
    setArgv([]);

    fsMock.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.includes("autonomy-remediation-state")) return JSON.stringify({});
      if (filePath.includes("autonomy-lanes.json")) {
        return JSON.stringify({
          posture: "balanced",
          familyCriticalCronNames: ["🤰 Pregnancy reminders / checklist"],
          familyCriticalLaneLabels: ["pregnancy reminders/checklists"],
          notes: [],
        });
      }
      throw new Error("missing");
    });

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = Array.isArray(args) ? args.join(" ") : "";
      if (cmd === "openclaw" && joined === "gateway status --no-probe") return { status: 0, stdout: "running", stderr: "" } as any;
      if (cmd === "npx" && String(args[2]).includes("check-cron-delivery.ts")) return { status: 0, stdout: "", stderr: "" } as any;
      if (cmd === "npx" && String(args[2]).includes("openai-cron-auth-guard.ts")) return { status: 0, stdout: JSON.stringify({ ok: true, affected: 0 }), stderr: "" } as any;
      if (cmd === "npx" && String(args[2]).includes("cron-auto-retry.ts")) return { status: 0, stdout: JSON.stringify({ retried: 1, skipped: 0, failedAgain: 1 }), stderr: "" } as any;
      if (cmd === "npx" && String(args[2]).includes("session-lifecycle-policy.ts")) return { status: 0, stdout: JSON.stringify({ status: "healthy" }), stderr: "" } as any;
      if (cmd === "/opt/homebrew/opt/postgresql@17/bin/psql") return { status: 0, stdout: "", stderr: "" } as any;
      throw new Error(`unexpected spawn ${cmd} ${joined}`);
    });

    await importFresh("../../tools/monitoring/autonomy-remediation.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    const output = consoleSpy.logs.join("\n");
    expect(output).toContain('"system": "cron"');
    expect(output).toContain('"status": "escalate"');
    expect(output).toContain('"familyCritical": true');
    expect(output).toContain('"verificationStatus": "uncertain"');
    expect(output).toContain('"escalationPath": "page Hamel because family-critical delivery is still uncertain after one bounded retry"');
    expect(output).toContain('"policyLesson": "appointments, calendar logistics, pregnancy reminders, and other never-miss reminders escalate after one failed verification path"');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
