import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushModuleSideEffects, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawnSync,
}));

beforeEach(() => {
  spawnSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("auto-executor", () => {
  it("delegates to the standalone shell runner", async () => {
    const exitSpy = mockExit();
    setArgv([]);
    spawnSync.mockReturnValue({ status: 0 } as any);

    await importFresh("../../tools/task-board/auto-executor.ts");
    await flushModuleSideEffects();

    const [cmd, args] = spawnSync.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("bash");
    expect(args[0]).toContain("auto-executor.sh");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
