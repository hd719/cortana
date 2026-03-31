import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, resetProcess } from "../test-utils";

type SpawnResult = { status?: number; stdout?: string; stderr?: string };

const spawnSync = vi.hoisted(() => vi.fn());
const withPostgresPath = vi.hoisted(() => vi.fn((env: NodeJS.ProcessEnv) => env));

vi.mock("node:child_process", () => ({ spawnSync }));
vi.mock("../../tools/lib/db.js", () => ({ withPostgresPath }));
vi.mock("../../tools/lib/paths.js", () => ({ PSQL_BIN: "/opt/homebrew/opt/postgresql@17/bin/psql" }));

beforeEach(() => {
  spawnSync.mockReset();
  withPostgresPath.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("gog oauth refresh", () => {
  it("retries transient non-auth probe failures before alerting", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as never);
    const consoleCapture = captureConsole();

    let probeCount = 0;
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (String(cmd).includes("psql")) return { status: 0, stdout: "", stderr: "" } as SpawnResult;
      if (cmd === "gog" && args[0] === "--account") {
        probeCount += 1;
        if (probeCount < 3) {
          return { status: 1, stdout: "", stderr: "temporary service unavailable" } as SpawnResult;
        }
        return { status: 0, stdout: "ok", stderr: "" } as SpawnResult;
      }
      return { status: 0, stdout: "", stderr: "" } as SpawnResult;
    });

    await importFresh("../../tools/gog/oauth-refresh.ts");

    expect(probeCount).toBe(3);
    expect(consoleCapture.logs.join("\n")).toContain("gog oauth ok");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("still fails fast on auth-like probe failures", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as never);
    const consoleCapture = captureConsole();

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (String(cmd).includes("psql")) return { status: 0, stdout: "", stderr: "" } as SpawnResult;
      if (cmd === "gog" && args[0] === "--account") {
        return { status: 1, stdout: "", stderr: "oauth token expired" } as SpawnResult;
      }
      if (cmd === "gog" && args[0] === "auth") {
        return { status: 0, stdout: "[]", stderr: "" } as SpawnResult;
      }
      return { status: 0, stdout: "", stderr: "" } as SpawnResult;
    });

    await importFresh("../../tools/gog/oauth-refresh.ts");

    expect(consoleCapture.errors.join("\n")).toContain("Manual re-auth required");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
