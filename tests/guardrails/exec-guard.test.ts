import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawnSync,
}));

beforeEach(() => {
  spawnSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("exec-guard", () => {
  it("requires a command", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv([]);

    await expect(importFresh("../../tools/guardrails/exec-guard.ts")).rejects.toThrow("process.exit:2");
    expect(consoleCapture.errors.join(" ")).toContain("Usage");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("blocks gateway restart", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["openclaw", "gateway", "restart"]);

    await expect(importFresh("../../tools/guardrails/exec-guard.ts")).rejects.toThrow("process.exit:42");
    expect(consoleCapture.errors.join(" ")).toContain("BLOCKED");
    expect(spawnSync).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(42);
  });

  it("executes allowed commands", async () => {
    const exitSpy = mockExit();
    setArgv(["echo", "hi"]);
    spawnSync.mockReturnValue({ status: 7 } as any);

    await expect(importFresh("../../tools/guardrails/exec-guard.ts")).rejects.toThrow("process.exit:7");
    expect(spawnSync).toHaveBeenCalledWith("echo", ["hi"], { stdio: "inherit" });
    expect(exitSpy).toHaveBeenCalledWith(7);
  });
});
