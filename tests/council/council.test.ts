import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushModuleSideEffects, captureConsole, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({ spawnSync }));
vi.mock("../../tools/lib/db.js", () => ({ withPostgresPath: (env: NodeJS.ProcessEnv) => env }));

beforeEach(() => {
  spawnSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("council CLI", () => {
  it("creates a session when psql succeeds", async () => {
    const sessionJson = JSON.stringify({
      ok: true,
      action: "create",
      session: { id: "123e4567-e89b-12d3-a456-426614174000", title: "test" },
    });
    spawnSync
      .mockReturnValueOnce({ status: 0, stdout: `${sessionJson}\n`, stderr: "" } as any)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any);

    const consoleCapture = captureConsole();
    setArgv([
      "create",
      "--type",
      "deliberation",
      "--title",
      "test",
      "--initiator",
      "unit-test",
      "--participants",
      "a,b",
      "--expires",
      "5",
      "--context",
      "{}",
    ]);

    await importFresh("../../tools/council/council.ts");
    await flushModuleSideEffects();

    expect(consoleCapture.logs.join(" ")).toContain('"ok":true');
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it("surfaces the underlying psql error when session creation fails", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv([
      "create",
      "--type",
      "deliberation",
      "--title",
      "test",
      "--initiator",
      "unit-test",
      "--participants",
      "a,b",
      "--expires",
      "5",
      "--context",
      "{}",
    ]);
    spawnSync.mockReturnValue({ status: 1, stderr: "psql: relation missing" } as any);

    await importFresh("../../tools/council/council.ts");
    await flushModuleSideEffects();

    expect(consoleCapture.logs.join(" ")).toContain("Failed to create session: psql: relation missing");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
