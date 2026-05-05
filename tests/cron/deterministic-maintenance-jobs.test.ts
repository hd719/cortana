import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getCommandJobSpec, validateCommandJobConfig } from "../../tools/cron/control-plane.ts";
import { inventoryCronJobs } from "../../tools/cron/deterministic-job-inventory.ts";

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("deterministic maintenance jobs", () => {
  it("rejects top-level command jobs and accepts nested command specs", () => {
    expect(validateCommandJobConfig({ jobs: [{ id: "bad", type: "command" }] })).toEqual([
      "bad: top-level type=command is invalid; use payload.kind=command or metadata.commandJobSpec",
    ]);

    const errors = validateCommandJobConfig({
      jobs: [{
        id: "ok",
        payload: { kind: "agentTurn" },
        metadata: {
          commandJobSpec: {
            command: "node",
            args: ["-e", "console.log('NO_REPLY')"],
            cwd: process.cwd(),
            timeoutMs: 1000,
            quietSuccess: "NO_REPLY",
            owner: "monitor",
          },
        },
      }],
    });

    expect(errors).toEqual([]);
  });

  it("extracts command specs from metadata", () => {
    const spec = getCommandJobSpec({
      id: "metadata-job",
      metadata: {
        commandJobSpec: {
          command: "npx",
          args: ["tsx", "tools/example.ts"],
          cwd: "/tmp",
          timeoutMs: 120000,
          quietSuccess: "NO_REPLY",
          owner: "monitor",
        },
      },
    });

    expect(spec).toMatchObject({
      id: "metadata-job",
      command: "npx",
      args: ["tsx", "tools/example.ts"],
      owner: "monitor",
    });
  });

  it("inventories migrated command specs and excludes judgment-heavy jobs", () => {
    const rows = inventoryCronJobs({
      jobs: [
        {
          id: "migrated",
          name: "Runtime vs Repo Drift Monitor",
          enabled: true,
          delivery: { accountId: "monitor" },
          payload: { kind: "agentTurn", timeoutSeconds: 60 },
          metadata: {
            commandJobSpec: {
              command: "node",
              args: ["-e", "console.log('NO_REPLY')"],
              cwd: process.cwd(),
              timeoutMs: 1000,
              quietSuccess: "NO_REPLY",
              owner: "monitor",
            },
          },
        },
        {
          id: "brief",
          name: "Morning brief",
          enabled: true,
          delivery: { accountId: "monitor" },
          payload: { kind: "agentTurn", message: "Run: npx tsx brief.ts\nIf output is NO_REPLY, return exactly NO_REPLY." },
        },
      ],
    });

    expect(rows.find((row) => row.id === "migrated")).toMatchObject({ included: true, migrationMode: "metadata-command-spec" });
    expect(rows.find((row) => row.id === "brief")).toMatchObject({ included: false, reason: "excluded as judgment-heavy or user-facing" });
  });

  it("runs quiet success locally without sending alerts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "command-job-"));
    const jobsFile = path.join(root, "jobs.json");
    writeJson(jobsFile, {
      jobs: [{
        id: "quiet",
        metadata: {
          commandJobSpec: {
            command: process.execPath,
            args: ["-e", "console.log('NO_REPLY')"],
            cwd: root,
            timeoutMs: 3000,
            quietSuccess: "NO_REPLY",
            owner: "monitor",
          },
        },
      }],
    });

    const result = spawnSync("npx", ["tsx", "tools/cron/command-job-runner.ts", "--job-id", "quiet", "--jobs-file", jobsFile, "--no-alert"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("NO_REPLY");
  });
});
