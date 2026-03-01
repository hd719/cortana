import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, mockExit, resetProcess, setArgv, useFixedTime } from "../test-utils";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
}));
const spawnSync = vi.hoisted(() => vi.fn());
const readJsonFile = vi.hoisted(() => vi.fn());
const writeJsonFileAtomic = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("child_process", () => ({
  spawnSync,
}));
vi.mock("../../tools/lib/json-file.js", () => ({
  readJsonFile,
  writeJsonFileAtomic,
}));

beforeEach(() => {
  fsMock.existsSync.mockReset();
  fsMock.mkdirSync.mockReset();
  fsMock.copyFileSync.mockReset();
  spawnSync.mockReset();
  readJsonFile.mockReset();
  writeJsonFileAtomic.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProcess();
});

describe("check-subagents", () => {
  it("reports failure when openclaw sessions fails", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv([]);

    spawnSync.mockImplementation((cmd: string) => {
      if (cmd === "/usr/bin/env") return { status: 0, stdout: "psql" } as any;
      if (cmd === "openclaw") return { status: 1, stderr: "no sessions" } as any;
      return { status: 0, stdout: "" } as any;
    });
    readJsonFile.mockReturnValue({});

    await expect(importFresh("../../tools/subagent-watchdog/check-subagents.ts")).rejects.toThrow(
      "process.exit:1"
    );
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.ok).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("handles empty session list", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["--no-emit-terminal"]);

    spawnSync.mockImplementation((cmd: string) => {
      if (cmd === "/usr/bin/env") return { status: 0, stdout: "psql" } as any;
      if (cmd === "openclaw") return { status: 0, stdout: JSON.stringify({ sessions: [] }) } as any;
      return { status: 0, stdout: "" } as any;
    });
    readJsonFile.mockReturnValue({});
    fsMock.existsSync.mockReturnValue(false);

    await expect(importFresh("../../tools/subagent-watchdog/check-subagents.ts")).rejects.toThrow(
      "process.exit:0"
    );
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.summary.failedOrTimedOut).toBe(0);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("logs and alerts on a failed subagent", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    useFixedTime("2025-01-01T00:00:00Z");
    setArgv(["--no-emit-terminal"]);

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "/usr/bin/env") return { status: 0, stdout: "psql" } as any;
      if (cmd === "openclaw") {
        return {
          status: 0,
          stdout: JSON.stringify({
            sessions: [
              {
                key: "agent:subagent:1",
                label: "huragok",
                status: "failed",
                ageMs: 200000,
                totalTokensFresh: false,
                sessionId: "sess-1",
                updatedAt: Date.now(),
              },
            ],
          }),
        } as any;
      }
      if (cmd === "psql") return { status: 0, stdout: "1" } as any;
      if (String(cmd).includes("telegram-delivery-guard")) return { status: 0, stdout: "" } as any;
      return { status: 0, stdout: "" } as any;
    });

    readJsonFile.mockReturnValue({});
    fsMock.existsSync.mockImplementation((p: string) => p.includes("telegram-delivery-guard"));

    await expect(importFresh("../../tools/subagent-watchdog/check-subagents.ts")).rejects.toThrow(
      "process.exit:0"
    );
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.summary.failedOrTimedOut).toBe(1);
    expect(payload.summary.loggedEvents).toBe(1);
    expect(payload.summary.alertsSent).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
