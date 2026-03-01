import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureConsole,
  importFresh,
  resetProcess,
  setArgv,
  useFixedTime,
} from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());
const readJsonFile = vi.hoisted(() => vi.fn());
const writeJsonFileAtomic = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());

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
vi.mock("../../tools/lib/db.js", () => ({
  query,
}));

beforeEach(() => {
  spawnSync.mockReset();
  readJsonFile.mockReset();
  writeJsonFileAtomic.mockReset();
  query.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProcess();
});

describe("vector-health-gate", () => {
  it("prints help and exits early", async () => {
    const consoleCapture = captureConsole();
    setArgv(["--help"]);

    await importFresh("../../tools/memory/vector-health-gate.ts");
    expect(consoleCapture.logs.join(" ")).toContain("usage: vector-health-gate.ts");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("queues reindex when chunks are zero", async () => {
    useFixedTime("2025-01-01T00:00:00Z");
    setArgv(["--json"]);
    readJsonFile.mockReturnValue({});
    query.mockReturnValue("0");

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === "memory" && args[1] === "status") {
        return { status: 0, stdout: JSON.stringify([{ status: { files: 2, chunks: 0, provider: "x", model: "y" } }]) } as any;
      }
      if (args[0] === "memory" && args[1] === "search") {
        return { status: 0, stdout: "ok", stderr: "" } as any;
      }
      if (args[0] === "memory" && args[1] === "index") {
        return { status: 0, stdout: "reindexed", stderr: "" } as any;
      }
      return { status: 0, stdout: "", stderr: "" } as any;
    });

    const consoleCapture = captureConsole();
    await importFresh("../../tools/memory/vector-health-gate.ts");

    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.reindex_attempted).toBe(true);
    expect(payload.reindex_ok).toBe(true);
    expect(payload.fallback_mode).toBe(false);
    expect(query).toHaveBeenCalled();
  });

  it("enters fallback after three consecutive 429s", async () => {
    useFixedTime("2025-01-01T00:00:00Z");
    setArgv(["--json"]);
    readJsonFile.mockReturnValue({ consecutive_embedding_429: 2, fallback_mode: false, reindex_queued: false });
    query.mockReturnValue("0");

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === "memory" && args[1] === "status") {
        return { status: 0, stdout: JSON.stringify([{ status: { files: 1, chunks: 5, provider: "x", model: "y" } }]) } as any;
      }
      if (args[0] === "memory" && args[1] === "search") {
        return { status: 1, stdout: "", stderr: "429 embedding quota error" } as any;
      }
      return { status: 0, stdout: "", stderr: "" } as any;
    });

    const consoleCapture = captureConsole();
    await importFresh("../../tools/memory/vector-health-gate.ts");

    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.fallback_mode).toBe(true);
    expect(payload.reindex_attempted).toBe(false);
    const savedState = writeJsonFileAtomic.mock.calls[0]?.[1] as any;
    expect(savedState.consecutive_embedding_429).toBe(3);
  });
});
