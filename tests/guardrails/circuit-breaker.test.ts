import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, mockExit, resetProcess, setArgv, useFixedTime } from "../test-utils";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));
const readJsonFile = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("../../tools/lib/json-file.js", () => ({
  readJsonFile,
}));

beforeEach(() => {
  fsMock.existsSync.mockReset();
  fsMock.mkdirSync.mockReset();
  fsMock.writeFileSync.mockReset();
  fsMock.renameSync.mockReset();
  readJsonFile.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProcess();
});

describe("circuit-breaker", () => {
  it("records a request and writes state", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    useFixedTime("2025-01-01T00:00:00Z");
    setArgv(["--record", "opus", "500", "--cooldown", "0"]);
    fsMock.existsSync.mockReturnValue(false);

    await expect(importFresh("../../tools/guardrails/circuit-breaker.ts")).rejects.toThrow("process.exit:0");
    const output = JSON.parse(consoleCapture.logs.join("\n"));
    expect(output.classification).toBe("retryable");
    expect(output.circuit).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it("prints status with ordered providers", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["--status"]);
    fsMock.existsSync.mockReturnValue(true);
    readJsonFile.mockReturnValue({
      version: 1,
      updated_at: "2025-01-01T00:00:00Z",
      config: {},
      providers: {
        sonnet: { provider: "sonnet", circuit: "closed", window: [], metrics: { success: 1 } },
        opus: { provider: "opus", circuit: "closed", window: [], metrics: { success: 2 } },
      },
    });

    await expect(importFresh("../../tools/guardrails/circuit-breaker.ts")).rejects.toThrow("process.exit:0");
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.providers[0].name).toBe("opus");
    expect(payload.providers[1].name).toBe("sonnet");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("recommends null when no providers exist", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv([]);
    fsMock.existsSync.mockReturnValue(false);

    await expect(importFresh("../../tools/guardrails/circuit-breaker.ts")).rejects.toThrow("process.exit:0");
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.recommended_provider).toBeNull();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
