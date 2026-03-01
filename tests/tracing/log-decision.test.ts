import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawnSync,
}));
vi.mock("../../tools/lib/paths.js", () => ({
  PSQL_BIN: "/usr/bin/psql",
  POSTGRES_PATH: "/usr/bin",
}));

beforeEach(() => {
  spawnSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("log-decision", () => {
  it("requires trigger/action fields", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv([]);

    await expect(importFresh("../../tools/tracing/log_decision.ts")).rejects.toThrow("process.exit:2");
    expect(consoleCapture.errors.join(" ")).toContain("usage: log_decision.ts");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("rejects invalid confidence", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv([
      "--trigger",
      "auto",
      "--action-type",
      "task",
      "--action-name",
      "run",
      "--confidence",
      "2",
    ]);

    await expect(importFresh("../../tools/tracing/log_decision.ts")).rejects.toThrow("process.exit:1");
    expect(consoleCapture.errors.join(" ")).toContain("confidence must be between 0 and 1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("logs a decision trace", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv([
      "--trace-id",
      "trace-1",
      "--trigger",
      "auto",
      "--action-type",
      "task",
      "--action-name",
      "run",
      "--outcome",
      "success",
      "--data-inputs",
      "{\"task_id\":1}",
      "--metadata",
      "{\"source\":\"test\"}",
    ]);
    spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" } as any);

    await expect(importFresh("../../tools/tracing/log_decision.ts")).rejects.toThrow("process.exit:0");
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.ok).toBe(true);
    expect(payload.trace_id).toBe("trace-1");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
