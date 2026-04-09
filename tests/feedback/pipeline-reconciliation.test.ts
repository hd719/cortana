import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, resetProcess } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());
const reconcileMissionControlFeedbackSignal = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("node:child_process", () => ({ spawnSync }));
vi.mock("../../tools/lib/db.js", () => ({
  withPostgresPath: (env: NodeJS.ProcessEnv) => env,
}));
vi.mock("../../tools/lib/paths.js", () => ({
  PSQL_BIN: "/opt/homebrew/opt/postgresql@17/bin/psql",
}));
vi.mock("../../tools/feedback/mission-control-feedback-signal.js", () => ({
  reconcileMissionControlFeedbackSignal,
}));

beforeEach(() => {
  spawnSync.mockReset();
  reconcileMissionControlFeedbackSignal.mockReset();
  reconcileMissionControlFeedbackSignal.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("feedback pipeline reconciliation", () => {
  it("classifies backlog vs breakage and lowers severity when only backlog", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as never);
    const consoleCapture = captureConsole();

    const scalarOut = ["98", "40", "12", "0", "22", "22", "0"]; // totals + unlinked/stuck/backlog/breakage
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "date") return { status: 0, stdout: "2026-03-04 08:00:00 EST" } as any;
      if (args.includes("-F")) return { status: 0, stdout: "" } as any;
      if (String(args?.[args.length - 1] ?? "").includes("INSERT INTO cortana_events")) return { status: 0, stdout: "" } as any;
      return { status: 0, stdout: `${scalarOut.shift() ?? "0"}\n` } as any;
    });

    await importFresh("../../tools/feedback/pipeline-reconciliation.ts");

    const output = consoleCapture.logs.join("\n");
    expect(output).toContain("Feedback pipeline: 22 stuck items >24h");
    expect(output).toContain("Next: Resume remediation");
    expect(reconcileMissionControlFeedbackSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        recurrenceKey: "ops:feedback-pipeline:stuck",
        signalState: "active",
      }),
    );

    const insertCall = spawnSync.mock.calls.find(([, args]) => String(args?.[args.length - 1] ?? "").includes("INSERT INTO cortana_events"));
    expect(String(insertCall?.[1]?.[insertCall[1].length - 1] ?? "")).toContain("'info'");
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it("returns NO_REPLY when feedback pipeline is clean", async () => {
    const consoleCapture = captureConsole();

    const scalarOut = ["0", "0", "0", "0", "0", "0", "0"];
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "date") return { status: 0, stdout: "2026-04-08 07:00:00 EDT" } as any;
      if (args.includes("-F")) return { status: 0, stdout: "" } as any;
      if (String(args?.[args.length - 1] ?? "").includes("INSERT INTO cortana_events")) return { status: 0, stdout: "" } as any;
      return { status: 0, stdout: `${scalarOut.shift() ?? "0"}\n` } as any;
    });

    await importFresh("../../tools/feedback/pipeline-reconciliation.ts");

    const output = consoleCapture.logs.join("\n");
    expect(output.trim()).toBe("NO_REPLY");
    expect(reconcileMissionControlFeedbackSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        recurrenceKey: "ops:feedback-pipeline:unlinked",
        signalState: "cleared",
      }),
    );
    expect(reconcileMissionControlFeedbackSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        recurrenceKey: "ops:feedback-pipeline:stuck",
        signalState: "cleared",
      }),
    );
  });

  it("ignores validation-seed feedback rows when reporting actionable gaps", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as never);
    const consoleCapture = captureConsole();

    const scalarOut = ["1", "0", "0", "0", "0", "0", "0"];
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "date") return { status: 0, stdout: "2026-04-08 09:55:00 EDT" } as any;
      if (args.includes("-F")) return { status: 0, stdout: "" } as any;
      if (String(args?.[args.length - 1] ?? "").includes("INSERT INTO cortana_events")) return { status: 0, stdout: "" } as any;
      return { status: 0, stdout: `${scalarOut.shift() ?? "0"}\n` } as any;
    });

    await importFresh("../../tools/feedback/pipeline-reconciliation.ts");

    expect(consoleCapture.logs.join("\n").trim()).toBe("NO_REPLY");
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it("excludes fresh system signal feedback from immediate unlinked backlog queries", async () => {
    const consoleCapture = captureConsole();

    const scalarOut = ["0", "0", "0", "0", "0", "0", "0"];
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "date") return { status: 0, stdout: "2026-04-09 14:00:00 EDT" } as any;
      if (args.includes("-F")) return { status: 0, stdout: "" } as any;
      if (String(args?.[args.length - 1] ?? "").includes("INSERT INTO cortana_events")) return { status: 0, stdout: "" } as any;
      return { status: 0, stdout: `${scalarOut.shift() ?? "0"}\n` } as any;
    });

    await importFresh("../../tools/feedback/pipeline-reconciliation.ts");

    const sqlCalls = spawnSync.mock.calls
      .map(([, args]) => String(args?.[args.length - 1] ?? ""))
      .filter((sql) => sql.includes("SELECT COUNT(*)"));
    expect(sqlCalls.some((sql) => sql.includes("producer_kind"))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes("category LIKE 'ops.%'"))).toBe(true);
    expect(consoleCapture.logs.join("\n").trim()).toBe("NO_REPLY");
  });
});
