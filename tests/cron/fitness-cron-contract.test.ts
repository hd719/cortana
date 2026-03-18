import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type CronJob = {
  id?: string;
  agentId?: string;
  delivery?: { accountId?: string };
  payload?: { model?: string; message?: string; timeoutSeconds?: number };
  schedule?: { expr?: string; tz?: string };
  name?: string;
};

function loadJobs(): CronJob[] {
  const jobsPath = path.resolve("config/cron/jobs.json");
  const raw = fs.readFileSync(jobsPath, "utf8");
  const json = JSON.parse(raw) as { jobs: CronJob[] };
  return json.jobs;
}

describe("fitness cron contract", () => {
  it("routes morning/evening/weekly briefs to Spartan and keeps healthcheck on Monitor", () => {
    const jobs = loadJobs();
    const morning = jobs.find((job) => job.id === "a519512a-5fb8-459f-8780-31e53793c1d4");
    const evening = jobs.find((job) => job.id === "e4db8a8d-945c-4af2-a8d5-e54f2fb4e792");
    const weekly = jobs.find((job) => job.id === "5aa1f47e-27e6-49cd-a20d-3dac0f1b8428");
    const healthcheck = jobs.find((job) => job.id === "661b21f1-741e-41a1-b41e-f413abeb2cdd");

    expect(morning?.delivery?.accountId).toBe("spartan");
    expect(evening?.delivery?.accountId).toBe("spartan");
    expect(weekly?.delivery?.accountId).toBe("spartan");
    expect(healthcheck?.delivery?.accountId).toBe("monitor");
  });

  it("keeps deterministic prompt contracts and removes broad insight marking", () => {
    const jobs = loadJobs();
    const morning = jobs.find((job) => job.id === "a519512a-5fb8-459f-8780-31e53793c1d4");
    const weekly = jobs.find((job) => job.id === "5aa1f47e-27e6-49cd-a20d-3dac0f1b8428");

    const morningMessage = String(morning?.payload?.message ?? "");
    const weeklyMessage = String(weekly?.payload?.message ?? "");
    expect(morningMessage).toContain("tools/fitness/morning-brief-data.ts");
    expect(morningMessage).toContain("hard truth");
    expect(morningMessage).toContain("insight_mark_sql");
    expect(morningMessage).not.toContain("'health' = ANY(domains)");

    expect(weeklyMessage).toContain("tools/fitness/weekly-insights-data.ts");
    expect(weeklyMessage).toContain("112-140g/day");
    expect(weeklyMessage).toContain("risk call");
  });

  it("defines whoop alert-only monitors with expected schedules and Spartan routing", () => {
    const jobs = loadJobs();
    const freshness = jobs.find((job) => job.id === "whoop-data-freshness-guard-20260318");
    const recoveryRisk = jobs.find((job) => job.id === "whoop-recovery-risk-alert-20260318");
    const overreach = jobs.find((job) => job.id === "whoop-overreach-guard-20260318");

    for (const job of [freshness, recoveryRisk, overreach]) {
      expect(job?.agentId).toBe("cron-fitness");
      expect(job?.delivery?.accountId).toBe("spartan");
      expect(String(job?.payload?.message ?? "")).toContain("return exactly NO_REPLY");
      expect(job?.payload?.model).toBe("openai-codex/gpt-5.3-codex");
    }

    expect(freshness?.schedule?.expr).toBe("20 6,12,18 * * *");
    expect(recoveryRisk?.schedule?.expr).toBe("5 9 * * *");
    expect(overreach?.schedule?.expr).toBe("15 19 * * *");
  });
});

