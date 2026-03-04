import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, resetProcess } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());
const randomUUID = vi.hoisted(() => vi.fn(() => "00000000-0000-4000-8000-000000000001"));

vi.mock("child_process", () => ({ spawnSync }));
vi.mock("crypto", () => ({ randomUUID }));

beforeEach(() => {
  spawnSync.mockReset();
  randomUUID.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("tools/feedback/sync-feedback", () => {
  it("maps HARD RULE correction rows to high severity and inserts recurrence key", async () => {
    const consoleCapture = captureConsole();

    spawnSync.mockImplementation((cmd: string, args: string[], opts?: { input?: string }) => {
      if (cmd !== "psql") return { status: 1, stderr: "unexpected command" } as any;

      const joined = args.join(" ");
      if (joined.includes("COPY (SELECT id, feedback_type, context, lesson, applied, timestamp FROM cortana_feedback")) {
        return {
          status: 0,
          stdout:
            "id,feedback_type,context,lesson,applied,timestamp\n" +
            "101,correction,E2E test: agent filtered CANSLIM results,HARD RULE: Always verify filtered output path,false,2026-03-04 09:58:12-05\n",
        } as any;
      }

      if (joined.includes("COPY (SELECT COALESCE(recurrence_key")) {
        return {
          status: 0,
          stdout: "recurrence_key,source_feedback_id\n",
        } as any;
      }

      if (opts?.input?.includes("INSERT INTO mc_feedback_items")) {
        expect(opts.input).toContain("'high'");
        expect(opts.input).toContain("'E2E test: agent filtered CANSLIM results'");
        expect(opts.input).toContain("'cortana_feedback:101'");
        return { status: 0, stdout: "" } as any;
      }

      return { status: 0, stdout: "" } as any;
    });

    await importFresh("../../tools/feedback/sync-feedback.ts");

    const output = consoleCapture.logs.join("\n");
    expect(output).toContain("Items inserted: 1");
    expect(output).toContain("Skipped duplicates (recurrence_key): 0");
  });

  it("treats E2E test correction context as high severity even without HARD RULE lesson text", async () => {
    spawnSync.mockImplementation((cmd: string, args: string[], opts?: { input?: string }) => {
      if (cmd !== "psql") return { status: 1, stderr: "unexpected command" } as any;

      const joined = args.join(" ");
      if (joined.includes("COPY (SELECT id, feedback_type, context, lesson, applied, timestamp FROM cortana_feedback")) {
        return {
          status: 0,
          stdout:
            "id,feedback_type,context,lesson,applied,timestamp\n" +
            "102,correction,E2E test correction,always test,false,2026-03-04 10:01:00-05\n",
        } as any;
      }

      if (joined.includes("COPY (SELECT COALESCE(recurrence_key")) {
        return { status: 0, stdout: "recurrence_key,source_feedback_id\n" } as any;
      }

      if (opts?.input?.includes("INSERT INTO mc_feedback_items")) {
        expect(opts.input).toContain("'high'");
        expect(opts.input).toContain("'E2E test correction'");
        expect(opts.input).toContain("'cortana_feedback:102'");
        return { status: 0, stdout: "" } as any;
      }

      return { status: 0, stdout: "" } as any;
    });

    await importFresh("../../tools/feedback/sync-feedback.ts");
  });
});
