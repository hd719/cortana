import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, resetProcess, setArgv, useFixedTime } from "../test-utils";

type JsonMap = Record<string, unknown>;
type SpawnResult = { status: number; stdout?: string; stderr?: string };

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
}));
const spawnSync = vi.hoisted(() => vi.fn());
const readJsonFile = vi.hoisted(() => vi.fn());
const writeJsonFileAtomic = vi.hoisted(() => vi.fn());
const rotateBackupRing = vi.hoisted(() => vi.fn());
const withFileLock = vi.hoisted(() => vi.fn((_: string, __: number, fn: () => unknown) => fn()));
const validateHeartbeatState = vi.hoisted(() => vi.fn((raw: JsonMap) => ({
  version: 2,
  lastChecks: {},
  lastRemediationAt: 0,
  subagentWatchdog: { lastRun: 0, lastLogged: {} },
  ...raw,
})));
const defaultHeartbeatState = vi.hoisted(() => vi.fn(() => ({
  version: 2,
  lastChecks: {},
  lastRemediationAt: 0,
  subagentWatchdog: { lastRun: 0, lastLogged: {} },
})));
const hashHeartbeatState = vi.hoisted(() => vi.fn(() => "mock-hash"));
const touchHeartbeat = vi.hoisted(() => vi.fn((state: JsonMap, nowMs: number) => ({ ...state, lastHeartbeat: nowMs })));
const isHeartbeatQuietHours = vi.hoisted(() => vi.fn(() => false));
const shouldSendHeartbeatAlert = vi.hoisted(() => vi.fn(() => true));

vi.mock("fs", () => ({ default: fsMock, ...fsMock }));
vi.mock("child_process", () => ({ spawnSync }));
vi.mock("../../tools/lib/json-file.js", () => ({
  readJsonFile,
  writeJsonFileAtomic,
  rotateBackupRing,
  withFileLock,
}));
vi.mock("../../tools/lib/heartbeat-schema.js", () => ({
  validateHeartbeatState,
  defaultHeartbeatState,
  hashHeartbeatState,
  touchHeartbeat,
  isHeartbeatQuietHours,
  shouldSendHeartbeatAlert,
  HEARTBEAT_REQUIRED_CHECKS: ["email", "calendar", "watchlist", "tasks", "portfolio", "marketIntel", "techNews", "weather", "fitness", "apiBudget", "mission", "cronDelivery"],
  HEARTBEAT_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
}));

beforeEach(() => {
  fsMock.existsSync.mockReset();
  fsMock.mkdirSync.mockReset();
  fsMock.copyFileSync.mockReset();
  spawnSync.mockReset();
  readJsonFile.mockReset();
  writeJsonFileAtomic.mockReset();
  rotateBackupRing.mockReset();
  withFileLock.mockReset();
  withFileLock.mockImplementation((_: string, __: number, fn: () => unknown) => fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProcess();
});

describe("check-subagents", () => {
  it("reports failure when openclaw sessions fails", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as never);
    const consoleCapture = captureConsole();
    setArgv([]);

    spawnSync.mockImplementation((cmd: string) => {
      if (cmd === "/usr/bin/env") return { status: 0, stdout: "psql" } as SpawnResult;
      if (cmd === "openclaw") return { status: 1, stderr: "no sessions" } as SpawnResult;
      return { status: 0, stdout: "" } as SpawnResult;
    });
    readJsonFile.mockReturnValue({});

    await importFresh("../../tools/subagent-watchdog/check-subagents.ts");
    await new Promise((r) => setTimeout(r, 0));
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.ok).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("handles empty session list", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as never);
    const consoleCapture = captureConsole();
    setArgv(["--no-emit-terminal"]);

    spawnSync.mockImplementation((cmd: string) => {
      if (cmd === "/usr/bin/env") return { status: 0, stdout: "psql" } as SpawnResult;
      if (cmd === "openclaw") return { status: 0, stdout: JSON.stringify({ sessions: [] }) } as SpawnResult;
      return { status: 0, stdout: "" } as SpawnResult;
    });
    readJsonFile.mockReturnValue({});
    fsMock.existsSync.mockReturnValue(false);

    await importFresh("../../tools/subagent-watchdog/check-subagents.ts");
    await new Promise((r) => setTimeout(r, 0));
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.summary.failedOrTimedOut).toBe(0);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("logs and alerts on a failed subagent", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as never);
    const consoleCapture = captureConsole();
    useFixedTime("2025-01-01T00:00:00Z");
    setArgv(["--no-emit-terminal"]);

    spawnSync.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === "/usr/bin/env") return { status: 0, stdout: "psql" } as SpawnResult;
      if (cmd === "openclaw") {
        return {
          status: 0,
          stdout: JSON.stringify({
            sessions: [
              {
                key: "agent:subagent:1",
                label: "huragok",
                status: "failed",
                ageMs: 60000,
                totalTokensFresh: true,
                sessionId: "sess-1",
                updatedAt: Date.now(),
              },
            ],
          }),
        } as SpawnResult;
      }
      // psql calls for event logging + alert delivery
      return { status: 0, stdout: "1" } as SpawnResult;
    });

    readJsonFile.mockImplementation((filePath: string) => {
      if (String(filePath).includes("runs.json")) return { runs: [] };
      // heartbeat state
      return {
        version: 2,
        lastChecks: {},
        lastRemediationAt: 0,
        subagentWatchdog: { lastRun: 0, lastLogged: {} },
      };
    });
    fsMock.existsSync.mockImplementation((p: string) => String(p).includes("telegram-delivery-guard"));

    await importFresh("../../tools/subagent-watchdog/check-subagents.ts");
    // Advance fake timers so queued setTimeout callbacks fire
    await vi.advanceTimersByTimeAsync(100);
    const output = consoleCapture.logs.join("\n");
    const payload = JSON.parse(output);
    expect(payload.summary.failedOrTimedOut).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
