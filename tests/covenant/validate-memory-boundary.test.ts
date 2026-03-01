import { afterEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

vi.mock("../../tools/lib/paths.js", () => ({
  resolveRepoPath: () => "/repo",
}));

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("validate-memory-boundary", () => {
  it("requires two arguments", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["agent1"]);

    await expect(importFresh("../../tools/covenant/validate_memory_boundary.ts")).rejects.toThrow(
      "process.exit:2"
    );
    expect(consoleCapture.errors.join(" ")).toContain("Usage");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("rejects paths outside the workspace", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["agent1", "/outside/file.txt"]);

    await expect(importFresh("../../tools/covenant/validate_memory_boundary.ts")).rejects.toThrow(
      "process.exit:1"
    );
    expect(consoleCapture.errors.join(" ")).toContain("MEMORY_BOUNDARY_VIOLATION");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("allows access to agent scratch", async () => {
    const consoleCapture = captureConsole();
    setArgv(["agent1", "/repo/.covenant/agents/agent1/scratch/output.txt"]);

    await importFresh("../../tools/covenant/validate_memory_boundary.ts");
    expect(consoleCapture.logs.join(" ")).toContain("MEMORY_BOUNDARY_OK");
  });
});
