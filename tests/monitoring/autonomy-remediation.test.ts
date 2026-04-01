import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
}));
const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("node:child_process", () => ({
  spawnSync,
}));

describe("autonomy-remediation", () => {
  beforeEach(() => {
    fsMock.readFileSync.mockReset();
    fsMock.writeFileSync.mockReset();
    fsMock.existsSync.mockReset();
    spawnSync.mockReset();
    fsMock.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  it("stays silent on healthy/no-op paths and remediates a transient critical cron failure", async () => {
    const exitSpy = mockExit();
    const consoleSpy = captureConsole();
    setArgv([]);
    fsMock.readFileSync.mockImplementation(() => {
      throw new Error("missing state");
    });

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "openclaw" && args.join(" ") === "gateway status --no-probe") {
        return { status: 0, stdout: "running", stderr: "" } as any;
      }
      if (cmd === "npx" && String(args[2]).includes("check-cron-delivery.ts")) {
        return { status: 0, stdout: "", stderr: "" } as any;
      }
      if (cmd === "npx" && String(args[2]).includes("openai-cron-auth-guard.ts")) {
        return { status: 0, stdout: JSON.stringify({ ok: true, affected: 0 }), stderr: "" } as any;
      }
      if (cmd === "npx" && String(args[2]).includes("cron-auto-retry.ts")) {
        return {
          status: 0,
          stdout: JSON.stringify({ retried: 1, skipped: 0, failedAgain: 0, results: [{ id: "job-1", success: true }] }),
          stderr: "",
        } as any;
      }
      if (cmd === "npx" && String(args[2]).includes("session-lifecycle-policy.ts")) {
        return { status: 0, stdout: JSON.stringify({ status: "remediated", cleanupChangedCount: 2 }), stderr: "" } as any;
      }
      if (cmd === "/opt/homebrew/opt/postgresql@17/bin/psql") {
        return { status: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`unexpected spawn ${cmd} ${args.join(" ")}`);
    });

    await importFresh("../../tools/monitoring/autonomy-remediation.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    const output = consoleSpy.logs.join("\n");
    expect(output).toContain('"system": "gateway"');
    expect(output).toContain('"status": "healthy"');
    expect(output).toContain('"system": "channel"');
    expect(output).toContain('"system": "cron"');
    expect(output).toContain('"system": "session"');
    expect(output).toContain('"status": "remediated"');
    expect(output).toContain('"posture": "balanced"');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("escalates instead of looping gateway restarts", async () => {
    const exitSpy = mockExit();
    const consoleSpy = captureConsole();
    setArgv([]);
    fsMock.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.includes("autonomy-remediation-state")) {
        return JSON.stringify({ gatewayRestarts: [Date.now() - 1000] });
      }
      throw new Error("missing");
    });

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "openclaw" && args.join(" ") === "gateway status --no-probe") {
        return { status: 1, stdout: "", stderr: "down" } as any;
      }
      if (cmd === "npx" && String(args[2]).includes("check-cron-delivery.ts")) {
        return { status: 0, stdout: "", stderr: "" } as any;
      }
      if (cmd === "npx" && String(args[2]).includes("openai-cron-auth-guard.ts")) {
        return { status: 0, stdout: JSON.stringify({ ok: true, affected: 0 }), stderr: "" } as any;
      }
      if (cmd === "npx" && String(args[2]).includes("cron-auto-retry.ts")) {
        return { status: 0, stdout: JSON.stringify({ retried: 0, skipped: 0, failedAgain: 0 }), stderr: "" } as any;
      }
      if (cmd === "npx" && String(args[2]).includes("session-lifecycle-policy.ts")) {
        return { status: 0, stdout: JSON.stringify({ status: "healthy" }), stderr: "" } as any;
      }
      if (cmd === "/opt/homebrew/opt/postgresql@17/bin/psql") {
        return { status: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`unexpected spawn ${cmd} ${args.join(" ")}`);
    });

    await importFresh("../../tools/monitoring/autonomy-remediation.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    const output = consoleSpy.logs.join("\n");
    expect(output).toContain('"system": "gateway"');
    expect(output).toContain('"status": "escalate"');
    expect(spawnSync).not.toHaveBeenCalledWith("openclaw", ["gateway", "restart"], expect.anything());
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
