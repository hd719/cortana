import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, resetProcess, setArgv } from "../test-utils";

const readFileSync = vi.hoisted(() => vi.fn());
const existsSync = vi.hoisted(() => vi.fn(() => true));

vi.mock("node:fs", () => ({
  default: {
    readFileSync,
    existsSync,
  },
}));

describe("ops-routing-drift-check", () => {
  beforeEach(() => {
    readFileSync.mockReset();
    existsSync.mockReset();
    existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  function seedFiles(entries: Record<string, string>) {
    readFileSync.mockImplementation((filePath: string) => {
      if (!(filePath in entries)) throw new Error(`missing: ${filePath}`);
      return entries[filePath];
    });
  }

  async function runScript(args: string[] = []) {
    setArgv(args);
    const consoleSpy = captureConsole();
    await importFresh("../../tools/monitoring/ops-routing-drift-check.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();
    return consoleSpy.logs.join("\n");
  }

  const rules = JSON.stringify({
    version: 1,
    stablePreferenceRules: [
      {
        id: "stable-docs",
        summary: "Monitor is the user-facing owner lane for inbox/email ops and maintenance alerts.",
        updateFiles: ["MEMORY.md", "HEARTBEAT.md", "docs/agent-routing.md", "docs/operating-rules.md", "README.md", "config/cron/jobs.json"],
        requiredDocs: [
          {
            path: "docs/agent-routing.md",
            phrases: ["Monitor is the user-facing owner lane for inbox/email ops and maintenance alerts"],
          },
        ],
      },
    ],
    routingRules: [
      {
        id: "monitor-owns-inbox-ops",
        scopeLabel: "inbox/email ops",
        expectedOwner: "monitor",
        jobKeywords: ["newsletter", "gmail", "inbox"],
        requireExplicitOwner: true,
        requireQuietHealthy: true,
      },
    ],
  });

  it("returns NO_REPLY when docs and cron ownership are aligned", async () => {
    seedFiles({
      "/repo/config/ops-hygiene-rules.json": rules,
      "/repo/docs/agent-routing.md": "Monitor is the user-facing owner lane for inbox/email ops and maintenance alerts.",
      "/repo/config/cron/jobs.json": JSON.stringify({
        jobs: [
          {
            id: "newsletter",
            name: "Newsletter digest",
            delivery: { accountId: "monitor" },
            payload: {
              message:
                "Use the message tool with accountId: monitor. If nothing new, return exactly NO_REPLY.",
            },
          },
        ],
      }),
    });

    const output = await runScript(["--repo-root", "/repo"]);
    expect(output).toContain("NO_REPLY");
  });

  it("flags prompt-owner drift and missing quiet healthy path", async () => {
    seedFiles({
      "/repo/config/ops-hygiene-rules.json": rules,
      "/repo/docs/agent-routing.md": "Monitor is the user-facing owner lane for inbox/email ops and maintenance alerts.",
      "/repo/config/cron/jobs.json": JSON.stringify({
        jobs: [
          {
            id: "newsletter",
            name: "Newsletter digest",
            delivery: { accountId: "monitor" },
            payload: {
              message:
                "Use the message tool with accountId: researcher. Send a digest whenever this runs.",
            },
          },
        ],
      }),
    });

    const output = await runScript(["--json", "--repo-root", "/repo"]);
    const payload = JSON.parse(output);
    expect(payload.status).toBe("needs_action");
    expect(payload.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "prompt_owner",
          jobId: "newsletter",
        }),
        expect.objectContaining({
          type: "quiet_path",
          jobId: "newsletter",
        }),
      ]),
    );
  });

  it("flags missing doc-contract phrases and surfaces canonical files to update", async () => {
    seedFiles({
      "/repo/config/ops-hygiene-rules.json": rules,
      "/repo/docs/agent-routing.md": "Cron jobs go to specialists.",
      "/repo/config/cron/jobs.json": JSON.stringify({ jobs: [] }),
    });

    const output = await runScript(["--json", "--repo-root", "/repo"]);
    const payload = JSON.parse(output);
    expect(payload.status).toBe("needs_action");
    expect(payload.findings[0]).toEqual(
      expect.objectContaining({
        type: "doc_contract",
        filesToUpdate: expect.arrayContaining(["docs/agent-routing.md", "config/cron/jobs.json"]),
      }),
    );
  });
});
