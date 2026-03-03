import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureStdout, flushModuleSideEffects, importFresh, mockExit, resetProcess, setArgv, useFixedTime } from "../test-utils";

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("child_process", () => ({
  spawnSync,
}));

beforeEach(() => {
  fsMock.readFileSync.mockReset();
  fsMock.writeFileSync.mockReset();
  spawnSync.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProcess();
});

describe("cron-restart-recovery", () => {
  it("outputs NO_REPLY and does nothing when there are no actionable gateway-drain failures", async () => {
    const exitSpy = mockExit();
    const stdoutCapture = captureStdout();
    setArgv([]);
    useFixedTime("2025-01-01T00:00:00Z");

    fsMock.readFileSync.mockImplementation((path: string) => {
      if (path.includes(".openclaw/cron/jobs.json")) {
        return JSON.stringify({
          jobs: [
            {
              id: "healthy",
              enabled: true,
              state: { lastRunAtMs: Date.now() - 1000, lastStatus: "ok", lastError: "" },
            },
          ],
        });
      }
      throw new Error("missing");
    });

    await importFresh("../../tools/alerting/cron-restart-recovery.ts");
    await flushModuleSideEffects();

    expect(stdoutCapture.writes.join("")).toContain("NO_REPLY");
    expect(spawnSync).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("detects gateway-drain failures, skips already-recovered keys, and retries selected candidates once", async () => {
    const exitSpy = mockExit();
    const stdoutCapture = captureStdout();
    setArgv([]);
    useFixedTime("2025-01-01T00:00:00Z");

    process.env.GATEWAY_DRAIN_MAX_RETRIES = "1";

    const now = Date.now();
    const runA = now - 5_000;
    const runB = now - 4_000;

    fsMock.readFileSync.mockImplementation((path: string) => {
      if (path.includes(".openclaw/cron/jobs.json")) {
        return JSON.stringify({
          jobs: [
            {
              id: "job-a",
              name: "Job A",
              enabled: true,
              state: { lastRunAtMs: runA, lastStatus: "failed", lastError: "GatewayDrainingError: draining" },
            },
            {
              id: "job-b",
              name: "Job B",
              enabled: true,
              state: { lastRunAtMs: runB, lastStatus: "error", lastError: "GatewayDrainingError: draining" },
            },
            {
              id: "job-c",
              name: "Job C",
              enabled: true,
              state: { lastRunAtMs: now - 3_000, lastStatus: "failed", lastError: "OtherError" },
            },
          ],
        });
      }
      if (path === "/tmp/cron-gateway-drain-recovery.json") {
        return JSON.stringify({ recovered: { [`job-a:${runA}`]: now - 10_000 } });
      }
      throw new Error(`unexpected read: ${path}`);
    });

    spawnSync.mockImplementation((cmd: string) => {
      if (cmd === "openclaw") {
        return { status: 0, stdout: "retry ok", stderr: "" } as any;
      }
      return { status: 0, stdout: "", stderr: "" } as any;
    });

    await importFresh("../../tools/alerting/cron-restart-recovery.ts");
    await flushModuleSideEffects();

    expect(spawnSync).toHaveBeenCalledWith(
      "openclaw",
      ["cron", "run", "job-b"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "/opt/homebrew/opt/postgresql@17/bin/psql",
      expect.any(Array),
      expect.objectContaining({ encoding: "utf8", stdio: "ignore" })
    );

    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    const persisted = String(fsMock.writeFileSync.mock.calls[0]?.[1] ?? "");
    expect(persisted).toContain(`"job-a:${runA}"`);
    expect(persisted).toContain(`"job-b:${runB}"`);

    expect(stdoutCapture.writes.join("")).toContain("NO_REPLY");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
