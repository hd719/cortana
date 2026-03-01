import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const runPsql = vi.hoisted(() => vi.fn());
vi.mock("../../tools/lib/db.js", () => ({
  runPsql,
}));

beforeEach(() => {
  runPsql.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("risk-score", () => {
  it("requires task-json", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv([]);

    await expect(importFresh("../../tools/governor/risk_score.ts")).rejects.toThrow("process.exit:2");
    expect(consoleCapture.errors.join(" ")).toContain("--task-json is required");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("denies unknown action types when policy says so", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    const task = { id: 1, metadata: { action_type: "mystery" } };
    setArgv(["--task-json", JSON.stringify(task)]);

    await expect(importFresh("../../tools/governor/risk_score.ts")).rejects.toThrow("process.exit:0");
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.decision).toBe("denied");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("approves low-risk internal writes", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    const task = { id: 2, metadata: { action_type: "internal-write" } };
    setArgv(["--task-json", JSON.stringify(task)]);

    await expect(importFresh("../../tools/governor/risk_score.ts")).rejects.toThrow("process.exit:0");
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.decision).toBe("approved");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
