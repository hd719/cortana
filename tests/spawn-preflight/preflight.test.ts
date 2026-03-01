import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());
const safeJsonParse = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawnSync,
}));
vi.mock("../../tools/lib/db.js", () => ({
  withPostgresPath: (env: NodeJS.ProcessEnv) => env,
}));
vi.mock("../../tools/lib/paths.js", () => ({
  repoRoot: () => "/repo",
}));
vi.mock("../../tools/lib/json-file.js", () => ({
  safeJsonParse,
}));

beforeEach(() => {
  spawnSync.mockReset();
  safeJsonParse.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("spawn-preflight", () => {
  it("exits with child status", async () => {
    const exitSpy = mockExit();
    setArgv(["--model", "openai-codex/gpt-5.3-codex", "--repo", "/repo"]);
    spawnSync.mockReturnValue({ status: 0 } as any);

    await expect(importFresh("../../tools/spawn-preflight/preflight.ts")).rejects.toThrow("process.exit:0");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("propagates non-zero status", async () => {
    const exitSpy = mockExit();
    setArgv(["--model", "openai-codex/gpt-5.3-codex", "--repo", "/repo"]);
    spawnSync.mockReturnValue({ status: 1 } as any);

    await expect(importFresh("../../tools/spawn-preflight/preflight.ts")).rejects.toThrow("process.exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("defaults to exit 1 when status missing", async () => {
    const exitSpy = mockExit();
    setArgv(["--model", "openai-codex/gpt-5.3-codex", "--repo", "/repo"]);
    spawnSync.mockReturnValue({} as any);

    await expect(importFresh("../../tools/spawn-preflight/preflight.ts")).rejects.toThrow("process.exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
