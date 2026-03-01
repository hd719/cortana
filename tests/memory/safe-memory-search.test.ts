import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureConsole,
  importFresh,
  mockExit,
  resetProcess,
  setArgv,
} from "../test-utils";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));
const spawnSync = vi.hoisted(() => vi.fn());
const readJsonFile = vi.hoisted(() => vi.fn());
const writeJsonFileAtomic = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("child_process", () => ({
  spawnSync,
}));
vi.mock("../../tools/lib/paths.js", () => ({
  resolveRepoPath: () => "/repo",
}));
vi.mock("../../tools/lib/json-file.js", () => ({
  readJsonFile,
  writeJsonFileAtomic,
}));

beforeEach(() => {
  fsMock.existsSync.mockReset();
  fsMock.readdirSync.mockReset();
  fsMock.readFileSync.mockReset();
  spawnSync.mockReset();
  readJsonFile.mockReset();
  writeJsonFileAtomic.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("safe-memory-search", () => {
  it("prints help when no args", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv([]);

    await expect(importFresh("../../tools/memory/safe-memory-search.ts")).rejects.toThrow("process.exit:2");
    expect(consoleCapture.logs.join(" ")).toContain("usage: safe-memory-search.ts");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("uses vector search when available", async () => {
    const consoleCapture = captureConsole();
    setArgv(["my", "query"]);
    readJsonFile.mockReturnValue({ fallback_mode: false });
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([{ id: 1, text: "hello" }]),
      stderr: "",
    } as any);

    await importFresh("../../tools/memory/safe-memory-search.ts");
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.mode).toBe("vector");
    expect(payload.results[0].id).toBe(1);
  });

  it("falls back to keyword search on vector failure", async () => {
    const consoleCapture = captureConsole();
    setArgv(["hamel"]);
    readJsonFile.mockReturnValue({ fallback_mode: false });
    spawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "429 quota exceeded",
    } as any);

    fsMock.existsSync.mockImplementation((p: string) => p === "/repo/MEMORY.md" || p === "/repo/memory");
    fsMock.readdirSync.mockReturnValue(["2025-01-01.md"]);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p.endsWith("MEMORY.md")) return "- Hamel likes espresso";
      return "Hamel project notes";
    });

    await importFresh("../../tools/memory/safe-memory-search.ts");
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.mode).toBe("keyword_fallback");
    expect(writeJsonFileAtomic).toHaveBeenCalled();
  });
});
