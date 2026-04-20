import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());
const existsSync = vi.hoisted(() => vi.fn(() => false));
const readFileSync = vi.hoisted(() => vi.fn(() => ""));

vi.mock("node:child_process", () => ({
  spawnSync,
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<any>("fs");
  const merged = { ...actual, existsSync, readFileSync };
  return {
    ...merged,
    default: merged,
  };
});

vi.mock("../../tools/lib/paths.js", () => ({
  resolveRepoPath: () => "/repo",
}));

describe("market-intel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    spawnSync.mockReset();
    existsSync.mockReset();
    existsSync.mockReturnValue(false);
    readFileSync.mockReset();
    readFileSync.mockReturnValue("");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetProcess();
  });

  async function runTicker() {
    const exitSpy = mockExit();
    const consoleSpy = captureConsole();
    setArgv(["--ticker", "TSLA"]);
    await importFresh("../../tools/market-intel/market-intel.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();
    return { exitSpy, logs: consoleSpy.logs, errors: consoleSpy.errors, warns: consoleSpy.warns };
  }

  it("invokes stock-analysis via npx tsx src/stock_analysis/main.ts", async () => {
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "npx") {
        return {
          status: 0,
          stdout: JSON.stringify({ price: 201, change_percent: 1.2, signal: "neutral" }),
          stderr: "",
        } as any;
      }
      if (cmd === "bird") {
        return { status: 1, stdout: "", stderr: "" } as any;
      }
      return { status: 0, stdout: "", stderr: "" } as any;
    });

    fetchMock.mockResolvedValue({
      text: async () => "Date,Open,High,Low,Close,Volume\n2024-01-02,1,2,0.5,3,100",
    });

    await runTicker();

    const npxCall = spawnSync.mock.calls.find((call) => call[0] === "npx");
    expect(npxCall).toBeTruthy();
    expect(npxCall?.[1]).toEqual(["tsx", "src/stock_analysis/main.ts", "analyze", "TSLA", "--json"]);
    const uvCall = spawnSync.mock.calls.find((call) => call[0] === "uv");
    expect(uvCall).toBeUndefined();
  });

  it("parses valid JSON stdout from stock-analysis", async () => {
    spawnSync.mockImplementation((cmd: string) => {
      if (cmd === "npx") {
        return {
          status: 0,
          stdout: JSON.stringify({ price: 201, change_percent: 1.2, signal: "neutral" }),
          stderr: "",
        } as any;
      }
      if (cmd === "bird") {
        return { status: 1, stdout: "", stderr: "" } as any;
      }
      return { status: 0, stdout: "", stderr: "" } as any;
    });

    fetchMock.mockResolvedValue({
      text: async () => "Date,Open,High,Low,Close,Volume\n2024-01-02,1,2,0.5,3,100",
    });

    const { exitSpy, logs } = await runTicker();
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(logs.join("\n")).toContain("Price: $201 (1.2%) [neutral]");
  });

  it("throws when stock-analysis exits non-zero", async () => {
    spawnSync.mockImplementation((cmd: string) => {
      if (cmd === "npx") {
        return { status: 1, stdout: "", stderr: "boom" } as any;
      }
      return { status: 0, stdout: "", stderr: "" } as any;
    });

    const { exitSpy, logs } = await runTicker();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logs.join("\n")).toContain("stock-analysis failed: boom");
  });

  it("loads bird auth from secret.env when process env is missing", async () => {
    existsSync.mockImplementation((filePath: string) => filePath.endsWith("/.config/bird/secret.env"));
    readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith("/.config/bird/secret.env")) {
        return "AUTH_TOKEN=test-auth\nCT0=test-ct0\n";
      }
      return "";
    });

    spawnSync.mockImplementation((cmd: string, args: string[], options?: { env?: Record<string, string> }) => {
      if (cmd === "npx") {
        return {
          status: 0,
          stdout: JSON.stringify({ price: 201, change_percent: 1.2, signal: "neutral" }),
          stderr: "",
        } as any;
      }
      if (cmd === "bird" && args[0] === "check") {
        expect(options?.env?.AUTH_TOKEN).toBe("test-auth");
        expect(options?.env?.CT0).toBe("test-ct0");
        return { status: 0, stdout: "ok", stderr: "" } as any;
      }
      if (cmd === "bird" && args[0] === "search") {
        expect(options?.env?.AUTH_TOKEN).toBe("test-auth");
        expect(options?.env?.CT0).toBe("test-ct0");
        return { status: 0, stdout: "[]", stderr: "" } as any;
      }
      return { status: 0, stdout: "", stderr: "" } as any;
    });

    fetchMock.mockResolvedValue({
      text: async () => "Date,Open,High,Low,Close,Volume\n2024-01-02,1,2,0.5,3,100",
    });

    const { exitSpy } = await runTicker();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
