import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawnSync,
}));
vi.mock("../../tools/lib/db.js", () => ({
  withPostgresPath: (env: NodeJS.ProcessEnv) => env,
}));

beforeEach(() => {
  spawnSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("council-tally", () => {
  it("requires a session id", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv([]);

    await expect(importFresh("../../tools/council/council-tally.ts")).rejects.toThrow("process.exit:1");
    expect(consoleCapture.logs.join(" ")).toContain("Missing --session");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects unknown args", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["--foo"]);

    await expect(importFresh("../../tools/council/council-tally.ts")).rejects.toThrow("process.exit:1");
    expect(consoleCapture.logs.join(" ")).toContain("Unknown arg");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("fails when psql errors", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["--session", "123e4567-e89b-12d3-a456-426614174000"]);
    spawnSync.mockReturnValue({ status: 1, stderr: "fail" } as any);

    await expect(importFresh("../../tools/council/council-tally.ts")).rejects.toThrow("process.exit:1");
    expect(consoleCapture.logs.join(" ")).toContain("Failed to tally session");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
