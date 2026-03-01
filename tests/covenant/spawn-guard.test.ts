import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, mockExit, resetProcess, setArgv, useFixedTime } from "../test-utils";

const fileStore = new Map<string, string>();
const dirStore = new Set<string>();

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
const runPsql = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("../../tools/lib/db.js", () => ({
  runPsql,
  withPostgresPath: (env: NodeJS.ProcessEnv) => env,
}));
vi.mock("../../tools/lib/paths.js", () => ({
  resolveRepoPath: () => "/repo",
}));

beforeEach(() => {
  fileStore.clear();
  dirStore.clear();
  fsMock.existsSync.mockReset();
  fsMock.readFileSync.mockReset();
  fsMock.writeFileSync.mockReset();
  fsMock.appendFileSync.mockReset();
  fsMock.mkdirSync.mockReset();
  runPsql.mockReset();

  fsMock.existsSync.mockImplementation((p: string) => fileStore.has(p) || dirStore.has(p) || p.includes("lifecycle_events.ts"));
  fsMock.readFileSync.mockImplementation((p: string) => fileStore.get(p) ?? "");
  fsMock.writeFileSync.mockImplementation((p: string, data: string) => {
    fileStore.set(p, String(data));
  });
  fsMock.appendFileSync.mockImplementation((p: string, data: string) => {
    const prev = fileStore.get(p) ?? "";
    fileStore.set(p, prev + String(data));
  });
  fsMock.mkdirSync.mockImplementation((p: string) => {
    dirStore.add(p);
  });

  runPsql.mockReturnValue({ status: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProcess();
});

describe("spawn-guard", () => {
  it("claims when no active entry exists", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    useFixedTime("2025-01-01T00:00:00Z");
    setArgv(["claim", "--label", "Test Label", "--run-id", "run-1"]);

    await expect(importFresh("../../tools/covenant/spawn_guard.ts")).rejects.toThrow("process.exit:0");
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.action).toBe("claimed");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("dedupes when an active entry exists", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    useFixedTime("2025-01-01T00:00:00Z");
    const registryPath = "/repo/tmp/spawn_guard_registry.json";
    const entry = {
      key: "task:none|label:my-label",
      normalized_label: "my-label",
      task_id: null,
      label: "My Label",
      run_id: "run-A",
      state: "running",
      started_at: 1,
      updated_at: Math.floor(Date.now() / 1000),
      ttl_seconds: 3600,
      metadata: {},
    };
    fileStore.set(registryPath, JSON.stringify({ entries: { [entry.key]: entry } }));

    setArgv(["claim", "--label", "My Label", "--run-id", "run-B"]);

    await expect(importFresh("../../tools/covenant/spawn_guard.ts")).rejects.toThrow("process.exit:0");
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.action).toBe("deduped");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("rejects release when run id mismatches", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    useFixedTime("2025-01-01T00:00:00Z");
    const registryPath = "/repo/tmp/spawn_guard_registry.json";
    const entry = {
      key: "task:none|label:test",
      normalized_label: "test",
      task_id: null,
      label: "test",
      run_id: "run-A",
      state: "running",
      started_at: 1,
      updated_at: Math.floor(Date.now() / 1000),
      ttl_seconds: 3600,
      metadata: {},
    };
    fileStore.set(registryPath, JSON.stringify({ entries: { [entry.key]: entry } }));

    setArgv(["release", "--label", "test", "--run-id", "run-B"]);

    await expect(importFresh("../../tools/covenant/spawn_guard.ts")).rejects.toThrow("process.exit:0");
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.action).toBe("noop");
    expect(payload.reason).toBe("run_id_mismatch");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
