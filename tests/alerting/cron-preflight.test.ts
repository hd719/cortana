import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const fsMock = vi.hoisted(() => ({
  constants: { X_OK: 1 },
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
  accessSync: vi.fn(),
}));
const spawnSync = vi.hoisted(() => vi.fn());
const runPsql = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("child_process", () => ({
  spawnSync,
}));
vi.mock("../../tools/lib/db.js", () => ({
  runPsql,
  withPostgresPath: (env: NodeJS.ProcessEnv) => env,
}));
vi.mock("../../tools/lib/paths.js", () => ({
  repoRoot: () => "/repo",
  resolveHomePath: (...parts: string[]) => `/home/${parts.join("/")}`,
}));

beforeEach(() => {
  fsMock.existsSync.mockReset();
  fsMock.mkdirSync.mockReset();
  fsMock.writeFileSync.mockReset();
  fsMock.rmSync.mockReset();
  fsMock.statSync.mockReset();
  fsMock.readdirSync.mockReset();
  fsMock.accessSync.mockReset();
  spawnSync.mockReset();
  runPsql.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("cron-preflight", () => {
  it("requires a cron name", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv([]);

    await expect(importFresh("../../tools/alerting/cron-preflight.ts")).rejects.toThrow("process.exit:2");
    expect(consoleCapture.logs.join(" ")).toContain("usage");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("quarantines on unknown check", async () => {
    const exitSpy = mockExit();
    setArgv(["daily-health", "unknown_check"]);
    runPsql.mockReturnValue({ status: 0 });
    fsMock.existsSync.mockReturnValue(false);

    await expect(importFresh("../../tools/alerting/cron-preflight.ts")).rejects.toThrow("process.exit:1");
    expect(fsMock.writeFileSync).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("releases quarantine when required checks pass", async () => {
    const qfile = "/home/.openclaw/cron/quarantine/cronA.quarantined";
    setArgv(["cronA", "pg"]);
    runPsql.mockReturnValue({ status: 0 });
    fsMock.existsSync.mockImplementation((p: string) => p === qfile);
    fsMock.readdirSync.mockReturnValue([]);

    await importFresh("../../tools/alerting/cron-preflight.ts");

    expect(fsMock.rmSync).toHaveBeenCalledWith(qfile, { force: true });
  });
});
