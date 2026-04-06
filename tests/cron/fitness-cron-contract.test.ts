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
    const monthly = jobs.find((job) => job.id === "monthly-fitness-overview-20260318");
    const healthcheck = jobs.find((job) => job.id === "661b21f1-741e-41a1-b41e-f413abeb2cdd");

    expect(morning?.delivery?.accountId).toBe("spartan");
    expect(evening?.delivery?.accountId).toBe("spartan");
    expect(weekly?.delivery?.accountId).toBe("spartan");
    expect(monthly?.delivery?.accountId).toBe("spartan");
    expect(healthcheck?.delivery?.accountId).toBe("monitor");
  });

  it("keeps non-overlapping briefing prompt contracts and removes broad insight marking", () => {
    const jobs = loadJobs();
    const morning = jobs.find((job) => job.id === "a519512a-5fb8-459f-8780-31e53793c1d4");
    const evening = jobs.find((job) => job.id === "e4db8a8d-945c-4af2-a8d5-e54f2fb4e792");
    const weekly = jobs.find((job) => job.id === "5aa1f47e-27e6-49cd-a20d-3dac0f1b8428");

    const morningMessage = String(morning?.payload?.message ?? "");
    const eveningMessage = String(evening?.payload?.message ?? "");
    const weeklyMessage = String(weekly?.payload?.message ?? "");
    expect(morningMessage).toContain("tools/fitness/morning-brief-data.ts");
    expect(morningMessage).toContain("morning_readiness");
    expect(morningMessage).toContain("readiness_support_signals");
    expect(morningMessage).toContain("color_emoji");
    expect(morningMessage).toContain("today_training_context");
    expect(morningMessage).toContain("today_mission.training.concrete_action");
    expect(morningMessage).toContain("today_mission.summary");
    expect(morningMessage).toContain("Longevity impact:");
    expect(morningMessage).toContain("age-100 objective");
    expect(morningMessage).toContain("tonal_sessions_today");
    expect(morningMessage).toContain("tonal_total_volume_today");
    expect(morningMessage).toContain("insight_mark_sql");
    expect(morningMessage).not.toContain("'health' = ANY(domains)");

    expect(eveningMessage).toContain("tools/fitness/evening-recap-data.ts");
    expect(eveningMessage).toContain("today_training_output");
    expect(eveningMessage).toContain("today_nutrition");
    expect(eveningMessage).toContain("nutrition_assumption");
    expect(eveningMessage).toContain("tonight_sleep_target");
    expect(eveningMessage).toContain("start with `Load:`");
    expect(eveningMessage).toContain("Do not call evening load signal \"readiness\"");
    expect(eveningMessage).toContain("Longevity impact:");
    expect(eveningMessage).toContain("age-100 objective");
    expect(eveningMessage).toContain("do not stop at \"unknown\"");
    expect(eveningMessage).toContain("Do not rehash morning readiness");

    expect(weeklyMessage).toContain("tools/fitness/weekly-insights-data.ts");
    expect(weeklyMessage).toContain("trend_signals");
    expect(weeklyMessage).toContain("hard_truth_inputs");
    expect(weeklyMessage).toContain("strength_context.tonal");
    expect(weeklyMessage).toContain("current_sessions");
    expect(weeklyMessage).toContain("current_total_volume");
    expect(weeklyMessage).toContain("age-100 objective");
    expect(weeklyMessage).toContain("112-140g/day");
    expect(weeklyMessage).toContain("protein_adherence_assumption");
    expect(weeklyMessage).toContain("coaching_outcome_evaluation.summary");
    expect(weeklyMessage).toContain("do not output only \"unknown\"");
    expect(weeklyMessage).toContain("state uncertainty rather than claiming zero strength output");
    expect(weeklyMessage).toContain("next 24h");
    expect(weeklyMessage).toContain("weekly_file_path");
    expect(weeklyMessage).toContain("weekly_repo_file_path");
    expect(weeklyMessage).toContain("do not fail the cron");
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
      expect(String(job?.payload?.message ?? "")).toContain("tools/fitness/fitness-alerts-data.ts");
      expect(String(job?.payload?.message ?? "")).toContain("mark_delivered_command");
    }

    expect(freshness?.schedule?.expr).toBe("20 6,12,18 * * *");
    expect(recoveryRisk?.schedule?.expr).toBe("5 9 * * *");
    expect(overreach?.schedule?.expr).toBe("15 19 * * *");
    expect(String(freshness?.payload?.message ?? "")).toContain("--types=freshness");
    expect(String(recoveryRisk?.payload?.message ?? "")).toContain("--types=recovery_risk");
    expect(String(overreach?.payload?.message ?? "")).toContain("--types=overreach,protein_miss,pain,schedule_conflict");
  });

  it("defines monthly fitness overview cron with DB artifact contract", () => {
    const jobs = loadJobs();
    const monthly = jobs.find((job) => job.id === "monthly-fitness-overview-20260318");
    const message = String(monthly?.payload?.message ?? "");

    expect(monthly?.agentId).toBe("cron-fitness");
    expect(monthly?.delivery?.accountId).toBe("spartan");
    expect(monthly?.schedule?.expr).toBe("5 20 1 * *");
    expect(monthly?.schedule?.tz).toBe("America/New_York");
    expect(monthly?.payload?.model).toBe("openai-codex/gpt-5.3-codex");
    expect(message).toContain("tools/fitness/monthly-overview-data.ts");
    expect(message).toContain("current.total_steps");
    expect(message).toContain("current.avg_daily_steps");
    expect(message).toContain("data_quality.step_coverage_days");
    expect(message).toContain("data_quality.readiness_coverage_days");
    expect(message).toContain("data_quality.sleep_coverage_days");
    expect(message).toContain("data_quality.tonal_volume");
    expect(message).toContain("do not imply the whole month lacks data");
    expect(message).toContain("age-100 objective");
  });
});
