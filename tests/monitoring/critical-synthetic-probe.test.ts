import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, resetProcess } from "../test-utils";

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
}));
const spawnSync = vi.hoisted(() => vi.fn());
const upsertOpenIncident = vi.hoisted(() => vi.fn());
const resolveIncident = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("node:child_process", () => ({
  spawnSync,
}));
vi.mock("../../tools/monitoring/autonomy-incidents.ts", () => ({
  upsertOpenIncident,
  resolveIncident,
}));

describe("critical-synthetic-probe", () => {
  beforeEach(() => {
    fsMock.readFileSync.mockReset();
    spawnSync.mockReset();
    upsertOpenIncident.mockReset();
    resolveIncident.mockReset();
    resetProcess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  function mockHealthyRuntimeFiles() {
    fsMock.readFileSync.mockImplementation((filePath: string) => {
      if (String(filePath).endsWith("/.openclaw/cron/jobs.json")) {
        return JSON.stringify({
          jobs: [
            {
              name: "📅 Calendar reminders → Telegram (ALL calendars)",
              state: { nextRunAtMs: Date.now() + 60_000, lastStatus: "ok", lastDeliveryStatus: "ok", consecutiveErrors: 0 },
            },
          ],
        });
      }
      if (String(filePath).endsWith("/config/autonomy-lanes.json")) {
        return JSON.stringify({ familyCriticalCronNames: ["📅 Calendar reminders → Telegram (ALL calendars)"] });
      }
      throw new Error(`unexpected read ${filePath}`);
    });
  }

  it("stays silent when the same actionable failure is already open and unchanged", async () => {
    mockHealthyRuntimeFiles();
    upsertOpenIncident.mockReturnValue("unchanged");

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = args.join(" ");
      if (cmd === "gog") return { status: 1, stdout: "", stderr: "oauth token expired" } as any;
      if (cmd === "remindctl") return { status: 0, stdout: "[]", stderr: "" } as any;
      if (cmd === "openclaw" && joined === "status --json") {
        return { status: 0, stdout: JSON.stringify({ gateway: { reachable: true }, channelSummary: ["Telegram: configured"] }), stderr: "" } as any;
      }
      if (cmd === "openclaw" && joined === "status") {
        return { status: 0, stdout: "Telegram | ON | OK", stderr: "" } as any;
      }
      if (cmd === "openclaw" && joined === "gateway status --no-probe") {
        return { status: 0, stdout: "running", stderr: "" } as any;
      }
      throw new Error(`unexpected spawn ${cmd} ${joined}`);
    });

    const consoleSpy = captureConsole();
    await importFresh("../../tools/monitoring/critical-synthetic-probe.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    expect(consoleSpy.logs.join("\n")).toContain("NO_REPLY");
    expect(upsertOpenIncident).toHaveBeenCalled();
  });

  it("alerts when an actionable failure is newly opened", async () => {
    mockHealthyRuntimeFiles();
    upsertOpenIncident.mockReturnValue("created");

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = args.join(" ");
      if (cmd === "gog") return { status: 1, stdout: "", stderr: "oauth token expired" } as any;
      if (cmd === "remindctl") return { status: 0, stdout: "[]", stderr: "" } as any;
      if (cmd === "openclaw" && joined === "status --json") {
        return { status: 0, stdout: JSON.stringify({ gateway: { reachable: true }, channelSummary: ["Telegram: configured"] }), stderr: "" } as any;
      }
      if (cmd === "openclaw" && joined === "status") {
        return { status: 0, stdout: "Telegram | ON | OK", stderr: "" } as any;
      }
      if (cmd === "openclaw" && joined === "gateway status --no-probe") {
        return { status: 0, stdout: "running", stderr: "" } as any;
      }
      throw new Error(`unexpected spawn ${cmd} ${joined}`);
    });

    const consoleSpy = captureConsole();
    await importFresh("../../tools/monitoring/critical-synthetic-probe.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    const output = consoleSpy.logs.join("\n");
    expect(output).toContain("Critical synthetic probes");
    expect(output).toContain("human_auth");
  });
});
