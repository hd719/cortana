import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const jobsPath = path.resolve("config/cron/jobs.json");

type CronJob = {
  id?: string;
  name?: string;
  payload?: {
    message?: string;
  };
  metadata?: {
    commandJobSpec?: { command?: string; args?: string[]; owner?: string };
    legacyAgentTurn?: { message?: string };
  };
  delivery?: {
    accountId?: string;
  };
};

function readJobs(): CronJob[] {
  return JSON.parse(fs.readFileSync(jobsPath, "utf8")).jobs as CronJob[];
}

describe("vacation cron contract", () => {
  it("wires morning and evening summaries to the deterministic vacation CLI", () => {
    const jobs = readJobs();
    const morning = jobs.find((job) => job.name === "🏖️ Vacation Ops Summary (AM)");
    const evening = jobs.find((job) => job.name === "🏖️ Vacation Ops Summary (PM)");

    expect(morning?.payload?.message).toContain("tools/vacation/vacation-ops.ts summary --period morning");
    expect(evening?.payload?.message).toContain("tools/vacation/vacation-ops.ts summary --period evening");
    expect(morning?.delivery?.accountId).toBe("monitor");
    expect(evening?.delivery?.accountId).toBe("monitor");
  });

  it("keeps the fragile guard pointed at the canonical vacation-mode guard script", () => {
    const jobs = readJobs();
    const guard = jobs.find((job) => job.name === "🏖️ Vacation Mode Fragile Guard (15m)");
    expect(guard?.payload?.message).toContain("command-job-runner.ts --job-id vacation-mode-fragile-guard-20260411 --alert");
    expect(guard?.metadata?.commandJobSpec).toMatchObject({
      command: "npx",
      args: ["tsx", "/Users/hd/Developer/cortana/tools/monitoring/vacation-mode-guard.ts"],
      owner: "monitor",
    });
    expect(guard?.metadata?.legacyAgentTurn?.message).toContain("tools/monitoring/vacation-mode-guard.ts");
    expect(guard?.delivery?.accountId).toBe("monitor");
  });
});
