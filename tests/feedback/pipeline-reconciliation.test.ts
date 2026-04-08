import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, resetProcess } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawnSync }));
vi.mock("../../tools/lib/db.js", () => ({
  withPostgresPath: (env: NodeJS.ProcessEnv) => env,
}));
vi.mock("../../tools/lib/paths.js", () => ({
  PSQL_BIN: "/opt/homebrew/opt/postgresql@17/bin/psql",
}));

beforeEach(() => {
  spawnSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("feedback pipeline reconciliation", () => {
  it("classifies backlog vs breakage and lowers severity when only backlog", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as never);
    const consoleCapture = captureConsole();

    const scalarOut = ["100", "98", "40", "12", "48", "22", "22", "0"]; // totals + lag/stuck/backlog/breakage
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "date") return { status: 0, stdout: "2026-03-04 08:00:00 EST" } as any;
      if (args.includes("-F")) return { status: 0, stdout: "" } as any;
      if (args.includes("INSERT INTO cortana_events")) return { status: 0, stdout: "" } as any;
      return { status: 0, stdout: `${scalarOut.shift() ?? "0"}\n` } as any;
    });

    await importFresh("../../tools/feedback/pipeline-reconciliation.ts");

    const output = consoleCapture.logs.join("\n");
    expect(output).toContain("Backlog (matched + task linked, waiting apply): 22");
    expect(output).toContain("Breakage (missing match and/or missing linked task): 0");

    const insertCall = spawnSync.mock.calls.find(([, args]) => String(args?.[args.length - 1] ?? "").includes("INSERT INTO cortana_events"));
    expect(String(insertCall?.[1]?.[insertCall[1].length - 1] ?? "")).toContain("'info'");
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it("ignores legacy applied cortana_feedback rows when computing lag", async () => {
    const consoleCapture = captureConsole();

    const scalarOut = ["51", "0", "0", "0", "0", "0", "0", "0"];
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "date") return { status: 0, stdout: "2026-04-08 07:00:00 EDT" } as any;
      if (args.includes("-F")) return { status: 0, stdout: "" } as any;
      if (args.includes("INSERT INTO cortana_events")) return { status: 0, stdout: "" } as any;
      return { status: 0, stdout: `${scalarOut.shift() ?? "0"}\n` } as any;
    });

    await importFresh("../../tools/feedback/pipeline-reconciliation.ts");

    const output = consoleCapture.logs.join("\n");
    expect(output).toContain("Lag (in cortana_feedback, missing in mc_feedback_items): 0");

    const lagCountCall = spawnSync.mock.calls.find(([, args]) =>
      String(args?.[args.length - 1] ?? "").includes("SELECT COUNT(*)\nFROM cortana_feedback f"),
    );
    expect(String(lagCountCall?.[1]?.[lagCountCall[1].length - 1] ?? "")).toContain(
      "COALESCE(f.applied, FALSE) = FALSE",
    );
  });
});
