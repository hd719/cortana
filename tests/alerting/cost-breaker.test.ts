import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushModuleSideEffects, captureConsole, importFresh, mockExit, resetProcess, setArgv, useFixedTime } from "../test-utils";

const fsMock = vi.hoisted(() => ({
  constants: { X_OK: 1 },
  accessSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

const spawnSync = vi.hoisted(() => vi.fn());
const runPsql = vi.hoisted(() => vi.fn());
const readJsonFile = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({ default: fsMock, ...fsMock }));
vi.mock("child_process", () => ({ spawnSync }));
vi.mock("../../tools/lib/db.js", () => ({ runPsql, withPostgresPath: (env: NodeJS.ProcessEnv) => env }));
vi.mock("../../tools/lib/paths.js", () => ({
  resolveHomePath: (...parts: string[]) => `/home/${parts.join("/")}`,
  resolveRuntimeStatePath: (...parts: string[]) => `/home/.openclaw/${parts.join("/")}`,
  resolveRepoPath: (...parts: string[]) => `/repo/${parts.join("/")}`,
}));
vi.mock("../../tools/lib/json-file.js", () => ({ readJsonFile }));

beforeEach(() => {
  fsMock.accessSync.mockReset();
  fsMock.mkdirSync.mockReset();
  fsMock.writeFileSync.mockReset();
  fsMock.rmSync.mockReset();
  spawnSync.mockReset();
  runPsql.mockReset();
  readJsonFile.mockReset();
  delete process.env.COST_BREAKER_MONTHLY_BUDGET_USD;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProcess();
});

describe("cost-breaker", () => {
  it("prints help and exits cleanly", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["--help"]);
    spawnSync.mockReturnValue({ status: 0, stdout: "{}", stderr: "" } as any);

    await importFresh("../../tools/alerting/cost-breaker.ts");
    await flushModuleSideEffects();
    expect(consoleCapture.logs.join(" ")).toContain("Usage");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("requires a session key for kill-runaway", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["--kill-runaway"]);
    spawnSync.mockReturnValue({ status: 0, stdout: "{}", stderr: "" } as any);

    await importFresh("../../tools/alerting/cost-breaker.ts");
    await flushModuleSideEffects();
    expect(consoleCapture.errors.join(" ")).toContain("--kill-runaway requires a sessionKey");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("writes a flag and sends a telegram alert on critical breach", async () => {
    useFixedTime("2025-01-10T12:00:00Z");
    process.env.COST_BREAKER_MONTHLY_BUDGET_USD = "0.01";
    setArgv([]);

    spawnSync.mockImplementation((cmd: string) => {
      if (cmd === "npx") {
        return {
          status: 0,
          stdout: JSON.stringify({ totalTokens: { input: 1000, output: 0 }, model: "gpt-5", provider: "openai" }),
          stderr: "",
        } as any;
      }
      return { status: 0, stdout: "", stderr: "" } as any;
    });
    fsMock.accessSync.mockImplementation(() => undefined);
    readJsonFile.mockReturnValue({});

    await importFresh("../../tools/alerting/cost-breaker.ts");

    const wroteFlag = fsMock.writeFileSync.mock.calls.find((call) => String(call[0]).includes("cost-alert.flag"));
    expect(wroteFlag).toBeTruthy();

    const telegramCall = spawnSync.mock.calls.find((call) => String(call[0]).includes("telegram-delivery-guard"));
    expect(telegramCall).toBeTruthy();
  });
});
