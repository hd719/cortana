import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const readJsonFile = vi.hoisted(() => vi.fn());
vi.mock("../../tools/lib/json-file.js", () => ({
  readJsonFile,
}));

beforeEach(() => {
  readJsonFile.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("approval-gate", () => {
  it("requires action and risk", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["--action", "do-stuff"]);

    await expect(importFresh("../../tools/guardrails/approval-gate.ts")).rejects.toThrow("process.exit:2");
    expect(consoleCapture.errors.join(" ")).toContain("--action and --risk are required");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("auto-approves low risk without fetch", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as any);
    setArgv(["--action", "local build", "--risk", "low"]);

    await expect(importFresh("../../tools/guardrails/approval-gate.ts")).rejects.toThrow("process.exit:0");
    expect(consoleCapture.logs.join(" ")).toContain("APPROVED");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("denies when no chat id is available", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    process.env.TELEGRAM_BOT_TOKEN = "token";
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: [] }),
    }));
    vi.stubGlobal("fetch", fetchSpy as any);

    setArgv(["--action", "send email", "--risk", "high"]);

    await expect(importFresh("../../tools/guardrails/approval-gate.ts")).rejects.toThrow("process.exit:1");
    expect(consoleCapture.logs.join(" ")).toContain("DENIED (no_chat_id)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
