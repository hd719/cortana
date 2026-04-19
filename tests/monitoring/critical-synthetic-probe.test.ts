import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, resetProcess } from "../test-utils";

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));
const spawnSync = vi.hoisted(() => vi.fn());
const upsertOpenIncident = vi.hoisted(() => vi.fn());
const resolveIncident = vi.hoisted(() => vi.fn());
const buildGogEnv = vi.hoisted(() => vi.fn((env: NodeJS.ProcessEnv, inherited: Record<string, string>) => ({ ...env, ...inherited })));
const resolveRealGogBin = vi.hoisted(() => vi.fn(() => "gog"));

vi.mock("node:fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("node:child_process", () => ({
  spawnSync,
}));
vi.mock("../../tools/gog/gog-with-env.ts", () => ({
  buildGogEnv,
  resolveRealGogBin,
}));
vi.mock("../../tools/monitoring/autonomy-incidents.ts", () => ({
  upsertOpenIncident,
  resolveIncident,
}));

describe("critical-synthetic-probe", () => {
  beforeEach(() => {
    fsMock.readFileSync.mockReset();
    fsMock.existsSync.mockReset();
    spawnSync.mockReset();
    upsertOpenIncident.mockReset();
    resolveIncident.mockReset();
    buildGogEnv.mockReset();
    resolveRealGogBin.mockReset();
    buildGogEnv.mockImplementation((env: NodeJS.ProcessEnv, inherited: Record<string, string>) => ({ ...env, ...inherited }));
    resolveRealGogBin.mockReturnValue("gog");
    resetProcess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  function mockHealthyRuntimeFiles() {
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockImplementation((filePath: string) => {
      if (String(filePath).endsWith("/.openclaw/cron/jobs.json")) {
        return JSON.stringify({
          jobs: [
            {
              id: "job-1",
              name: "📅 Calendar reminders → Telegram (ALL calendars)",
              state: { lastRunAtMs: Date.now(), nextRunAtMs: Date.now() + 60_000, lastStatus: "ok", lastDeliveryStatus: "ok", consecutiveErrors: 0 },
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

  it("uses gateway plist GOG keyring password for headless gog probe", async () => {
    mockHealthyRuntimeFiles();
    upsertOpenIncident.mockReturnValue("created");
    delete process.env.GOG_KEYRING_PASSWORD;
    fsMock.existsSync.mockImplementation((filePath: string) =>
      String(filePath).endsWith("/Library/LaunchAgents/ai.openclaw.gateway.plist"),
    );

    spawnSync.mockImplementation((cmd: string, args: string[], options?: { env?: Record<string, string> }) => {
      const joined = args.join(" ");
      if (cmd === "plutil") {
        return {
          status: 0,
          stdout: JSON.stringify({ EnvironmentVariables: { GOG_KEYRING_PASSWORD: "secret-from-plist" } }),
          stderr: "",
        } as any;
      }
      if (cmd === "gog") {
        expect(options?.env?.GOG_KEYRING_PASSWORD).toBe("secret-from-plist");
        return { status: 0, stdout: "ok", stderr: "" } as any;
      }
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
  });

  it("retries transient gog timeouts before opening an incident", async () => {
    mockHealthyRuntimeFiles();
    upsertOpenIncident.mockReturnValue("unchanged");
    let gogCalls = 0;

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = args.join(" ");
      if (cmd === "gog") {
        gogCalls += 1;
        if (gogCalls === 1) {
          return { status: 1, stdout: "", stderr: "", error: new Error("Command timed out after 15000ms") } as any;
        }
        return { status: 0, stdout: "ok", stderr: "" } as any;
      }
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

    expect(gogCalls).toBe(2);
    expect(consoleSpy.logs.join("\n")).toContain("NO_REPLY");
    expect(upsertOpenIncident).not.toHaveBeenCalled();
  });

  it("prefers fresh cron run history over stale job state for the critical lane", async () => {
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockImplementation((filePath: string) => {
      if (String(filePath).endsWith("/.openclaw/cron/jobs.json")) {
        return JSON.stringify({
          jobs: [
            {
              id: "job-1",
              name: "📅 Calendar reminders → Telegram (ALL calendars)",
              state: {
                lastRunAtMs: 1,
                nextRunAtMs: 1,
                lastStatus: "ok",
                lastDeliveryStatus: "not-delivered",
                consecutiveErrors: 0,
              },
            },
          ],
        });
      }
      if (String(filePath).endsWith("/.openclaw/cron/runs/job-1.jsonl")) {
        return [
          JSON.stringify({
            ts: Date.now(),
            action: "finished",
            status: "ok",
            deliveryStatus: "not-delivered",
            nextRunAtMs: Date.now() + 60_000,
          }),
        ].join("\n");
      }
      if (String(filePath).endsWith("/config/autonomy-lanes.json")) {
        return JSON.stringify({ familyCriticalCronNames: ["📅 Calendar reminders → Telegram (ALL calendars)"] });
      }
      throw new Error(`unexpected read ${filePath}`);
    });
    upsertOpenIncident.mockReturnValue("unchanged");

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = args.join(" ");
      if (cmd === "gog") return { status: 0, stdout: "ok", stderr: "" } as any;
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
  });
});
