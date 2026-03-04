import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, captureStdout, importFresh, resetProcess, setArgv } from "../test-utils";

type SpawnResult = { status?: number; stdout?: string; stderr?: string };

const spawnSync = vi.hoisted(() => vi.fn());
const fsMock = vi.hoisted(() => ({ existsSync: vi.fn() }));

vi.mock("child_process", () => ({ spawnSync }));
vi.mock("fs", () => ({ default: fsMock, ...fsMock }));

beforeEach(() => {
  spawnSync.mockReset();
  fsMock.existsSync.mockReset();
  fsMock.existsSync.mockReturnValue(true);
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("check-subagents-with-retry", () => {
  it("fails fast with explicit preflight reasons", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as never);
    const consoleCapture = captureConsole();

    fsMock.existsSync.mockReturnValue(false);
    spawnSync.mockReturnValue({ status: 1, stdout: "" } as SpawnResult);

    await importFresh("../../tools/subagent-watchdog/check-subagents-with-retry.ts");

    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.failFast).toBe(true);
    expect(payload.failures.length).toBeGreaterThan(0);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not retry non-timeout failures", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as never);
    const stdout = captureStdout();
    setArgv(["--no-emit-terminal"]);

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "/usr/bin/env" || cmd === "git") return { status: 0, stdout: "ok" } as SpawnResult;
      if (cmd === "npx") {
        return {
          status: 1,
          stdout: JSON.stringify({ summary: { failedOrTimedOut: 1 }, failedAgents: [{ reasonCode: "failed_status", status: "failed" }] }),
        } as SpawnResult;
      }
      return { status: 0, stdout: "" } as SpawnResult;
    });

    await importFresh("../../tools/subagent-watchdog/check-subagents-with-retry.ts");

    const npxCalls = spawnSync.mock.calls.filter((c) => c[0] === "npx");
    expect(npxCalls).toHaveLength(1);
    expect(stdout.writes.join("\n")).toContain("failedOrTimedOut");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("retries once for timeout-only failures and applies timeout profile", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as never);
    const consoleCapture = captureConsole();
    setArgv(["--timeout-profile", "heavy", "--task-type", "research", "--no-emit-terminal"]);
    process.env.SUBAGENT_TASK_TIMEOUT_PROFILE_MAP = JSON.stringify({ research: "extreme" });

    let npxCount = 0;
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "/usr/bin/env" || cmd === "git") return { status: 0, stdout: "ok" } as SpawnResult;
      if (cmd === "sleep") return { status: 0, stdout: "" } as SpawnResult;
      if (cmd === "npx") {
        npxCount += 1;
        if (npxCount === 1) {
          return {
            status: 1,
            stdout: JSON.stringify({ summary: { failedOrTimedOut: 1 }, failedAgents: [{ reasonCode: "runtime_exceeded", status: "timeout" }] }),
          } as SpawnResult;
        }
        return { status: 0, stdout: JSON.stringify({ summary: { failedOrTimedOut: 0 }, failedAgents: [] }) } as SpawnResult;
      }
      return { status: 0, stdout: "" } as SpawnResult;
    });

    await importFresh("../../tools/subagent-watchdog/check-subagents-with-retry.ts");

    const npxCalls = spawnSync.mock.calls.filter((c) => c[0] === "npx");
    expect(npxCalls).toHaveLength(2);
    const secondArgs = npxCalls[1][1] as string[];
    expect(secondArgs).toContain("--max-runtime-seconds");
    expect(secondArgs).toContain("900");

    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.reliability.metrics.retryCount).toBe(1);
    expect(payload.reliability.metrics.successAfterRetry).toBe(true);
    expect(payload.reliability.metrics.reasonCounts.runtime_exceeded).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
