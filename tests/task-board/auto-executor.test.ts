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
  it("uses a BASH_SOURCE fallback so bash -c with set -u does not crash", async () => {
    const exitSpy = mockExit();
    setArgv([]);
    spawnSync.mockReturnValue({ status: 0 } as any);

    await importFresh("../../tools/task-board/auto-executor.ts");
    await flushModuleSideEffects();

    const [, args] = spawnSync.mock.calls[0] as [string, string[]];
    expect(args[1]).toContain('${BASH_SOURCE[0]-}');
    expect(args[1]).not.toContain('${BASH_SOURCE[0]}" == "$0"');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
