import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushModuleSideEffects, captureConsole, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const readJsonFile = vi.hoisted(() => vi.fn());
const createApprovalRequest = vi.hoisted(() => vi.fn());
const recordApprovalDecision = vi.hoisted(() => vi.fn());

vi.mock("../../tools/lib/json-file.js", () => ({
  readJsonFile,
}));
vi.mock("../../tools/lib/mission-control-ledger.js", () => ({
  createApprovalRequest,
  recordApprovalDecision,
}));

beforeEach(() => {
  readJsonFile.mockReset();
  createApprovalRequest.mockReset();
  recordApprovalDecision.mockReset();
  createApprovalRequest.mockReturnValue("11111111-1111-1111-1111-111111111111");
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

    await importFresh("../../tools/guardrails/approval-gate.ts");
    await flushModuleSideEffects();
    expect(consoleCapture.errors.join(" ")).toContain("--action and --risk are required");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("auto-approves low risk without fetch or ledger writes", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as any);
    setArgv(["--action", "local build", "--risk", "low"]);

    await importFresh("../../tools/guardrails/approval-gate.ts");
    await flushModuleSideEffects();
    expect(consoleCapture.logs.join(" ")).toContain("APPROVED");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });


  it("rejects cleanly when chat lookup throws", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    process.env.TELEGRAM_BOT_TOKEN = "token";
    readJsonFile.mockReturnValue({ channels: { telegram: {} } });
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    vi.stubGlobal("fetch", fetchSpy as any);

    setArgv(["--action", "send email", "--risk", "high"]);

    await importFresh("../../tools/guardrails/approval-gate.ts");
    await flushModuleSideEffects();
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(recordApprovalDecision).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "rejected",
      "system",
      "chat_lookup_failed",
    );
    expect(consoleCapture.logs.join(" ")).toContain("DENIED (chat_lookup_failed)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
  it("creates and rejects an approval when no chat id is available", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    process.env.TELEGRAM_BOT_TOKEN = "token";
    readJsonFile.mockReturnValue({ channels: { telegram: {} } });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: [] }),
    }));
    vi.stubGlobal("fetch", fetchSpy as any);

    setArgv(["--action", "send email", "--risk", "high"]);

    await importFresh("../../tools/guardrails/approval-gate.ts");
    await flushModuleSideEffects();
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(recordApprovalDecision).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "rejected",
      "system",
      "no_chat_id",
    );
    expect(consoleCapture.logs.join(" ")).toContain("DENIED (no_chat_id)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
