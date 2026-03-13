import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushModuleSideEffects, importFresh, resetProcess } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawnSync }));
vi.mock("../../tools/lib/paths.js", () => ({
  PSQL_BIN: "/opt/homebrew/opt/postgresql@17/bin/psql",
  resolveRepoPath: (...parts: string[]) => ["/repo", ...parts].join("/"),
}));

beforeEach(() => {
  spawnSync.mockReset();
  process.env.TRIAGE_SEND_TELEGRAM = "1";
  process.env.TRIAGE_RUN_INBOX_EXECUTION = "1";
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

function mockDefaultPipeline(): void {
  spawnSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "gog") {
      return { status: 0, stdout: "[]", stderr: "" } as any;
    }
    if (cmd === "test") {
      return { status: 0, stdout: "", stderr: "" } as any;
    }
    if (cmd === "python3") {
      return { status: 0, stdout: '{"stats":{"orphan":0,"stale":0}}', stderr: "" } as any;
    }
    if (String(cmd).includes("psql")) {
      return { status: 0, stdout: "", stderr: "" } as any;
    }
    return { status: 0, stdout: "", stderr: "" } as any;
  });
}

describe("email-triage-autopilot", () => {
  it("exports PSQL_BIN + PATH to inbox_to_execution subprocess", async () => {
    mockDefaultPipeline();

    await importFresh("../../tools/gmail/email-triage-autopilot.ts");
    await flushModuleSideEffects();

    const pyCall = spawnSync.mock.calls.find((c) => c[0] === "python3");
    const env = (pyCall?.[2] as any)?.env ?? {};
    expect(typeof env.PSQL_BIN).toBe("string");
    const psqlBin = String(env.PSQL_BIN);
    expect(
      psqlBin === "psql" || psqlBin.includes("postgresql@17/bin/psql"),
    ).toBe(true);

    // PATH should include the Homebrew postgres bin when using an absolute PSQL_BIN,
    // but fallback mode may legitimately rely on existing PATH + plain `psql`.
    if (psqlBin.includes("postgresql@17/bin/psql")) {
      expect(String(env.PATH || "")).toContain("/opt/homebrew/opt/postgresql@17/bin");
    }
  });

  it("uses telegram delivery guard instead of context-bound cron wake", async () => {
    mockDefaultPipeline();

    await importFresh("../../tools/gmail/email-triage-autopilot.ts");
    await flushModuleSideEffects();

    const calledCommands = spawnSync.mock.calls.map((c) => String(c[0]));
    expect(calledCommands.some((c) => c.includes("telegram-delivery-guard.sh"))).toBe(true);
    expect(calledCommands.includes("openclaw")).toBe(false);
  });
});
