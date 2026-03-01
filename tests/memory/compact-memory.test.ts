import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureConsole,
  captureStderr,
  importFresh,
  mockExit,
  resetProcess,
  useFixedTime,
} from "../test-utils";

const fileStore = new Map<string, string>();
const dirStore = new Set<string>();

const fsMock = vi.hoisted(() => ({
  constants: { X_OK: 1 },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
  rmSync: vi.fn(),
  accessSync: vi.fn(),
}));

const execSync = vi.hoisted(() => vi.fn());
const runPsql = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("child_process", () => ({
  execSync,
}));
vi.mock("../../tools/lib/db.js", () => ({
  runPsql,
  withPostgresPath: (env: NodeJS.ProcessEnv) => env,
}));
vi.mock("../../tools/lib/paths.js", () => ({
  repoRoot: () => "/repo",
  PSQL_BIN: "/usr/bin/psql",
}));

beforeEach(() => {
  fileStore.clear();
  dirStore.clear();
  fsMock.existsSync.mockReset();
  fsMock.readFileSync.mockReset();
  fsMock.writeFileSync.mockReset();
  fsMock.renameSync.mockReset();
  fsMock.mkdirSync.mockReset();
  fsMock.statSync.mockReset();
  fsMock.readdirSync.mockReset();
  fsMock.rmSync.mockReset();
  fsMock.accessSync.mockReset();
  execSync.mockReset();
  runPsql.mockReset();

  fsMock.existsSync.mockImplementation((p: string) => fileStore.has(p) || dirStore.has(p));
  fsMock.readFileSync.mockImplementation((p: string) => fileStore.get(p) ?? "");
  fsMock.writeFileSync.mockImplementation((p: string, data: string) => {
    fileStore.set(p, String(data));
  });
  fsMock.renameSync.mockImplementation((src: string, dest: string) => {
    const data = fileStore.get(src);
    if (data !== undefined) {
      fileStore.set(dest, data);
      fileStore.delete(src);
    }
  });
  fsMock.mkdirSync.mockImplementation((p: string) => {
    dirStore.add(p);
  });
  fsMock.statSync.mockImplementation((p: string) => ({
    isFile: () => fileStore.has(p),
    isDirectory: () => dirStore.has(p),
    size: (fileStore.get(p) ?? "").length,
  }));
  fsMock.readdirSync.mockImplementation((p: string) => {
    if (p === "/repo/memory") return ["2024-01-01.md"];
    return [];
  });
  fsMock.rmSync.mockImplementation((p: string) => {
    fileStore.delete(p);
    dirStore.delete(p);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProcess();
});

describe("compact-memory", () => {
  it("exits when MEMORY.md is missing", async () => {
    const exitSpy = mockExit();
    const stderr = captureStderr();
    await expect(importFresh("../../tools/memory/compact-memory.ts")).rejects.toThrow("process.exit:1");
    expect(stderr.writes.join(" ")).toContain("MEMORY.md not found");
    expect(exitSpy).toHaveBeenCalledWith(1);
    stderr.restore();
  });

  it("archives old daily notes and writes a report", async () => {
    useFixedTime("2025-01-10T00:00:00Z");
    dirStore.add("/repo/memory");
    fileStore.set("/repo/MEMORY.md", "- Keep focus\n- Keep focus\nDate 2024-01-01\n");
    fileStore.set("/repo/memory/2024-01-01.md", "old note");
    execSync.mockImplementation(() => {
      throw new Error("no date");
    });
    fsMock.accessSync.mockImplementation(() => {
      throw new Error("no psql");
    });

    const consoleCapture = captureConsole();
    await importFresh("../../tools/memory/compact-memory.ts");

    const archivedPath = "/repo/memory/archive/2024/01/2024-01-01.md";
    expect(fileStore.has(archivedPath)).toBe(true);
    const reportWritten = [...fileStore.keys()].some((p) => p.includes("reports/memory-compaction/compaction-"));
    expect(reportWritten).toBe(true);
    expect(consoleCapture.logs.join(" ")).toContain("Memory compaction complete");
  });

  it("skips psql logging when psql is not executable", async () => {
    useFixedTime("2025-01-10T00:00:00Z");
    dirStore.add("/repo/memory");
    fileStore.set("/repo/MEMORY.md", "- Item\n");
    execSync.mockImplementation(() => {
      throw new Error("no date");
    });
    fsMock.accessSync.mockImplementation(() => {
      throw new Error("no psql");
    });

    await importFresh("../../tools/memory/compact-memory.ts");
    expect(runPsql).not.toHaveBeenCalled();
  });
});
