import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));
const runPsql = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({ default: fsMock, ...fsMock }));
vi.mock("../../tools/lib/db.js", () => ({
  runPsql,
}));

beforeEach(() => {
  fsMock.existsSync.mockReset();
  fsMock.readFileSync.mockReset();
  fsMock.copyFileSync.mockReset();
  fsMock.writeFileSync.mockReset();
  fsMock.renameSync.mockReset();
  runPsql.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENCLAW_SESSIONS_FILE;
});

describe("reconcile-sessions", () => {
  it("reconciles missing completed session files in dry-run mode", async () => {
    process.env.OPENCLAW_SESSIONS_FILE = "/tmp/sessions.json";
    fsMock.existsSync.mockImplementation((filePath: string) => filePath === "/tmp/sessions.json");
    fsMock.readFileSync.mockReturnValue(JSON.stringify({
      "session-1": {
        status: "running",
        sessionFile: "/tmp/missing.jsonl",
        result: "done",
      },
    }));
    runPsql.mockReturnValue({ status: 0, stdout: "[]", stderr: "" });

    const { main } = await import("../../tools/session-reconciler/reconcile-sessions.ts");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalArgv = process.argv;
    process.argv = ["node", "reconcile-sessions.ts", "--dry-run"];

    await main();

    process.argv = originalArgv;
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"sessions_reconciled":1'));
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("marks orphaned covenant runs and emits run events", async () => {
    process.env.OPENCLAW_SESSIONS_FILE = "/tmp/sessions.json";
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ "active-session": { status: "running" } }));
    runPsql
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify([{ id: 42, agent: "main", mission: "debug", session_key: "missing-session", started_at: "2026-05-14T00:00:00Z" }]),
        stderr: "",
      })
      .mockReturnValue({ status: 0, stdout: "", stderr: "" });

    const { main } = await import("../../tools/session-reconciler/reconcile-sessions.ts");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalArgv = process.argv;
    process.argv = ["node", "reconcile-sessions.ts"];

    await main();

    process.argv = originalArgv;
    expect(runPsql).toHaveBeenCalledWith(expect.stringContaining("UPDATE cortana_covenant_runs"), { db: "cortana" });
    expect(runPsql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO cortana_run_events"), { db: "cortana" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"runs_reconciled_unknown":1'));
    logSpy.mockRestore();
  });

  it("fails when the OpenClaw sessions file is missing", async () => {
    process.env.OPENCLAW_SESSIONS_FILE = "/tmp/missing-sessions.json";
    fsMock.existsSync.mockReturnValue(false);

    const { main } = await import("../../tools/session-reconciler/reconcile-sessions.ts");
    await expect(main()).rejects.toThrow("sessions file missing");
  });
});
