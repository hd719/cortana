import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type CronJob = {
  id?: string;
  payload?: { message?: string; timeoutSeconds?: number };
  metadata?: {
    commandJobSpec?: { command?: string; args?: string[]; cwd?: string; owner?: string; quietSuccess?: string };
    legacyAgentTurn?: { message?: string };
  };
};

function loadJobs(): CronJob[] {
  const jobsPath = path.resolve("config/cron/jobs.json");
  const raw = fs.readFileSync(jobsPath, "utf8");
  const json = JSON.parse(raw) as { jobs: CronJob[] };
  return json.jobs;
}

describe("reminder cron contract", () => {
  it("keeps calendar reminders on the deterministic command runner instead of prompt-owned calendar math", () => {
    const jobs = loadJobs();
    const calendar = jobs.find((job) => job.id === "9401d91c-5fa0-43a6-a18e-01030f9e5ba5");
    const message = String(calendar?.payload?.message ?? "");

    expect(calendar?.payload?.timeoutSeconds).toBe(120);
    expect(message).toContain("command-job-runner.ts --job-id 9401d91c-5fa0-43a6-a18e-01030f9e5ba5 --alert");
    expect(message).not.toContain("Compute minutes-until-start");
    expect(calendar?.metadata?.commandJobSpec).toMatchObject({
      command: "npx",
      args: ["tsx", "/Users/hd/Developer/cortana/tools/gog/calendar-reminders-telegram.ts"],
      cwd: "/Users/hd/.openclaw/workspaces/cron-comms",
      quietSuccess: "NO_REPLY",
      owner: "monitor",
    });
  });

  it("forces Apple Reminders cron to exec the wrapper first with no pre-read drift", () => {
    const jobs = loadJobs();
    const reminders = jobs.find((job) => job.id === "1ee84e93-cae4-4469-8da4-313312bf06e2");
    const message = String(reminders?.payload?.message ?? "");

    expect(reminders?.payload?.timeoutSeconds).toBe(90);
    expect(message).toContain("First action must be one `exec` tool call");
    expect(message).toContain("Do not read files, search the repo, inspect skills");
    expect(message).toContain("bash /Users/hd/Developer/cortana/tools/reminders/run-apple-reminders-monitor.sh");
    expect(message).toContain("host: gateway");
    expect(message).toContain("security: full");
    expect(message).toContain("ask: off");
  });

  it("forces deferred gateway restart through explicit non-interactive exec settings", () => {
    const jobs = loadJobs();
    const restart = jobs.find((job) => job.id === "a9c37f59-8f34-4c59-bb53-8a2b6d3fb3f8");
    const message = String(restart?.payload?.message ?? "");
    const legacy = String(restart?.metadata?.legacyAgentTurn?.message ?? "");

    expect(restart?.payload?.timeoutSeconds).toBe(120);
    expect(message).toContain("command-job-runner.ts --job-id a9c37f59-8f34-4c59-bb53-8a2b6d3fb3f8 --alert");
    expect(message).toContain("host `gateway`");
    expect(message).toContain("security `full`");
    expect(message).toContain("ask `off`");
    expect(restart?.metadata?.commandJobSpec).toMatchObject({
      command: "bash",
      args: ["/Users/hd/Developer/cortana/tools/openclaw/post-update.sh", "--restart-if-pending"],
      cwd: "/Users/hd/.openclaw/workspaces/cron-maintenance",
      owner: "monitor",
    });
    expect(legacy).toContain("First action must be one `exec` tool call");
    expect(legacy).toContain("Do not ask for approval.");
  });
});
