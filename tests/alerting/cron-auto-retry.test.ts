import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushModuleSideEffects, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
}));
const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("child_process", () => ({
  spawnSync,
}));

describe("cron-auto-retry", () => {
  beforeEach(() => {
    fsMock.readFileSync.mockReset();
    spawnSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  it("retries only first-failure transient critical cron jobs", async () => {
    const exitSpy = mockExit();
    setArgv(["--critical-only", "--json"]);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        jobs: [
          {
            id: "job-1",
            name: "☀️ Morning brief (Hamel)",
            state: { consecutiveFailures: 1, lastError: "GatewayDrainingError: draining" },
          },
          {
            id: "job-2",
            name: "☀️ Morning brief (Hamel)",
            state: { consecutiveFailures: 2, lastError: "timeout" },
          },
          {
            id: "job-3",
            name: "☀️ Morning brief (Hamel)",
            state: { consecutiveFailures: 1, lastError: "SyntaxError: bad token" },
          },
          {
            id: "job-4",
            name: "non-critical",
            state: { consecutiveFailures: 1, lastError: "timeout" },
          },
        ],
      })
    );
    spawnSync.mockImplementation((cmd: string) => {
      if (cmd === "openclaw") return { status: 0, stdout: "retry ok", stderr: "" } as any;
      return { status: 0, stdout: "", stderr: "" } as any;
    });

    await importFresh("../../tools/alerting/cron-auto-retry.ts");
    await flushModuleSideEffects();

    expect(spawnSync).toHaveBeenCalledWith("openclaw", ["cron", "run", "job-1"], expect.objectContaining({ encoding: "utf8" }));
    expect(spawnSync).not.toHaveBeenCalledWith("openclaw", ["cron", "run", "job-2"], expect.anything());
    expect(spawnSync).not.toHaveBeenCalledWith("openclaw", ["cron", "run", "job-3"], expect.anything());
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
