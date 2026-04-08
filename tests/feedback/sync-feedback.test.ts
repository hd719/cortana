import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, resetProcess } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({ spawnSync }));

beforeEach(() => {
  spawnSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("tools/feedback/sync-feedback", () => {
  it("exits early when legacy cortana_feedback is already a view", async () => {
    const consoleCapture = captureConsole();
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = `${cmd} ${args.join(" ")}`;
      if (joined.includes("SELECT c.relkind")) {
        return { status: 0, stdout: "relkind\nv\n" } as any;
      }
      return { status: 0, stdout: "" } as any;
    });

    await importFresh("../../tools/feedback/sync-feedback.ts");

    expect(consoleCapture.logs.join("\n")).toContain("Legacy cortana_feedback table has been retired; nothing to sync.");
  });
});
