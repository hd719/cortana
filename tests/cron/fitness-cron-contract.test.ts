import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type CronJob = {
  id?: string;
  agentId?: string;
  enabled?: boolean;
  delivery?: { accountId?: string };
  payload?: { model?: string; message?: string; timeoutSeconds?: number };
  schedule?: { expr?: string; tz?: string };
  name?: string;
  state?: Record<string, unknown>;
};

function loadJobs(): CronJob[] {
  const jobsPath = path.resolve("config/cron/jobs.json");
  const raw = fs.readFileSync(jobsPath, "utf8");
  const json = JSON.parse(raw) as { jobs: CronJob[] };
  return json.jobs;
}

describe("fitness cron contract", () => {
  it("routes event/evening/weekly briefs to Spartan and keeps healthcheck on Monitor", () => {
    const jobs = loadJobs();
    const eventCoach = jobs.find((job) => job.id === "spartan-whoop-event-coach-20260511");
    const morning = jobs.find((job) => job.id === "a519512a-5fb8-459f-8780-31e53793c1d4");
    const evening = jobs.find((job) => job.id === "e4db8a8d-945c-4af2-a8d5-e54f2fb4e792");
    const weekly = jobs.find((job) => job.id === "5aa1f47e-27e6-49cd-a20d-3dac0f1b8428");
    const monthly = jobs.find((job) => job.id === "monthly-fitness-overview-20260318");
    const healthcheck = jobs.find((job) => job.id === "661b21f1-741e-41a1-b41e-f413abeb2cdd");

    expect(eventCoach?.enabled).toBe(true);
    expect(eventCoach?.delivery?.accountId).toBe("spartan");
    expect(morning?.enabled).toBe(false);
    expect(morning?.delivery?.accountId).toBe("spartan");
    expect(evening?.delivery?.accountId).toBe("spartan");
    expect(weekly?.delivery?.accountId).toBe("spartan");
    expect(monthly?.delivery?.accountId).toBe("spartan");
    expect(healthcheck?.delivery?.accountId).toBe("monitor");
  });

  it("defines the event-driven WHOOP coach with dedupe and delivery handoff", () => {
    const jobs = loadJobs();
    const eventCoach = jobs.find((job) => job.id === "spartan-whoop-event-coach-20260511");
    const message = String(eventCoach?.payload?.message ?? "");

    expect(eventCoach?.agentId).toBe("cron-fitness");
    expect(eventCoach?.schedule?.expr).toBe("*/2 * * * *");
    expect(eventCoach?.schedule?.tz).toBe("America/New_York");
    expect(eventCoach?.payload?.model).toBe("openai-codex/gpt-5.3-codex");
    expect(message).toContain("tools/fitness/whoop-event-coaching-data.ts");
    expect(message).toContain("mark_delivered_command");
    expect(message).toContain("openclaw message send --channel telegram --account spartan");
    expect(message).toContain("Do not use the Write tool");
    expect(message).toContain("Do not use the message tool");
    expect(message).toContain("MESSAGE=$(cat <<'EOF'");
    expect(message).toContain("Do not mark delivered before sending");
    expect(message).toContain("wake_recovery");
    expect(message).toContain("post_workout");
    expect(message).not.toContain("identities/spartan/VOICE.md");
    expect(message).toContain("isolated workspace");
    expect(message).toContain("Do not repeat the precursor message");
  });

  it("keeps non-overlapping briefing prompt contracts and folds overreach into evening", () => {
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
    expect(morningMessage).toContain("identities/spartan/VOICE.md");
    expect(morningMessage).toContain("Sound like a real coach texting one athlete");
    expect(morningMessage).toContain("Conversational, not robotic");
    expect(morningMessage).toContain("1-2 facts that changed the call");
    expect(morningMessage).toContain("Write like a smart trainer who knows the athlete");
    expect(morningMessage).toContain("Keep the age-100 objective in mind");
    expect(morningMessage).toContain("VOICE rewrite gate");
    expect(morningMessage).toContain("tonal_sessions_today");
    expect(morningMessage).toContain("tonal_total_volume_today");
    expect(morningMessage).toContain("Do not start with a metric stack, heading, or numbered list");
    expect(morningMessage).toContain("Do not use literal labels or memo phrasing");
    expect(morningMessage).toContain("Confidence is low");
    expect(morningMessage).toContain("Top 5 priorities");
    expect(morningMessage).toContain("You're 🟡 at 53");
    expect(morningMessage).toContain("Use at most one metric unless a second one clearly changes the call");
    expect(morningMessage).toContain("insight_mark_sql");
    expect(morningMessage).not.toContain("'health' = ANY(domains)");

    expect(eveningMessage).toContain("tools/fitness/evening-recap-data.ts");
    expect(eveningMessage).toContain("today_training_output");
    expect(eveningMessage).toContain("identities/spartan/VOICE.md");
    expect(eveningMessage).toContain("today_nutrition");
    expect(eveningMessage).toContain("nutrition_assumption");
    expect(eveningMessage).toContain("tonight_sleep_target");
    expect(eveningMessage).toContain("Sound like a real coach following up after the day");
    expect(eveningMessage).toContain("Write like a text follow-up, not a summary report");
    expect(eveningMessage).toContain("Use the 1-2 facts that matter most tonight");
    expect(eveningMessage).toContain("Do not call evening load signal \"readiness\"");
    expect(eveningMessage).toContain("Keep the age-100 objective in mind");
    expect(eveningMessage).toContain("VOICE rewrite gate");
    expect(eveningMessage).toContain("do not stop at \"unknown\"");
    expect(eveningMessage).toContain("Do not rehash morning readiness");
    expect(eveningMessage).toContain("overreach");

    expect(weeklyMessage).toContain("tools/fitness/weekly-insights-data.ts");
    expect(weeklyMessage).toContain("identities/spartan/VOICE.md");
    expect(weeklyMessage).toContain("trend_signals");
    expect(weeklyMessage).toContain("hard_truth_inputs");
    expect(weeklyMessage).toContain("strength_context.tonal");
    expect(weeklyMessage).toContain("current_sessions");
    expect(weeklyMessage).toContain("current_total_volume");
    expect(weeklyMessage).toContain("Write like one weekly check-in text");
    expect(weeklyMessage).toContain("112-140g/day");
    expect(weeklyMessage).toContain("protein_adherence_assumption");
    expect(weeklyMessage).toContain("coaching_outcome_evaluation.summary");
    expect(weeklyMessage).toContain("Sound like a real coach wrapping the week");
    expect(weeklyMessage).toContain("VOICE rewrite gate");
    expect(weeklyMessage).toContain("do not output only \"unknown\"");
    expect(weeklyMessage).toContain("state uncertainty rather than claiming zero strength output");
    expect(weeklyMessage).toContain("next 24 hours");
    expect(weeklyMessage).toContain("4-5 sentences max");
    expect(weeklyMessage).toContain("Call out the one hard truth that matters most, in prose rather than as a label");
    expect(weeklyMessage).toContain("Do not start with a heading, metric stack, `Key insight`, `Current-state assessment`, or `Top 5` framing");
    expect(weeklyMessage).toContain("Do not use numbered lists, memo labels, or phrases like `Hard truth:`, `Confidence is low`, `Overall trajectory:`, or `Next week actions:`");
    expect(weeklyMessage).toContain("Mention at most 2 metrics, and only when they directly support the call");
    expect(weeklyMessage).toContain("weekly_file_path");
    expect(weeklyMessage).toContain("weekly_repo_file_path");
    expect(weeklyMessage).toContain("do not fail the cron");
  });

  it("retires standalone freshness/recovery/overreach alert crons", () => {
    const jobs = loadJobs();
    const freshness = jobs.find((job) => job.id === "whoop-data-freshness-guard-20260318");
    const recoveryRisk = jobs.find((job) => job.id === "whoop-recovery-risk-alert-20260318");
    const overreach = jobs.find((job) => job.id === "whoop-overreach-guard-20260318");

    expect(freshness?.enabled).toBe(false);
    expect(recoveryRisk?.enabled).toBe(false);
    expect(overreach?.enabled).toBe(false);
    expect(freshness?.state?.retiredReason).toContain("Spartan morning brief");
    expect(freshness?.state?.retiredReason).toContain("event-driven WHOOP coaching");
    expect(recoveryRisk?.state?.retiredReason).toContain("webhook-driven");
    expect(overreach?.state?.retiredReason).toContain("Evening Recap");

    expect(freshness?.agentId).toBe("cron-fitness");
    expect(freshness?.delivery?.accountId).toBe("spartan");
    expect(String(freshness?.payload?.message ?? "")).toContain("return exactly NO_REPLY");
    expect(freshness?.payload?.model).toBe("openai-codex/gpt-5.3-codex");
    expect(String(freshness?.payload?.message ?? "")).toContain("tools/fitness/fitness-alerts-data.ts");
    expect(String(freshness?.payload?.message ?? "")).toContain("mark_delivered_command");
    expect(String(freshness?.payload?.message ?? "")).toContain("identities/spartan/VOICE.md");
    expect(String(freshness?.payload?.message ?? "")).toContain("2 short sentences");
    expect(String(freshness?.payload?.message ?? "")).toContain("Lead with what Hamel should do now");
    expect(String(freshness?.payload?.message ?? "")).toContain("Do not use labels, bullets, report tone");
    expect(String(freshness?.payload?.message ?? "")).toContain("VOICE rewrite gate");
    expect(freshness?.schedule?.expr).toBe("20 6,12,18 * * *");
    expect(String(freshness?.payload?.message ?? "")).toContain("--types=freshness");
    expect(String(freshness?.payload?.message ?? "")).toContain("keep today easy");
    expect(String(freshness?.payload?.message ?? "")).toContain("Zone 2 until data refreshes");
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
    expect(message).toContain("identities/spartan/VOICE.md");
    expect(message).toContain("current.total_steps");
    expect(message).toContain("current.avg_daily_steps");
    expect(message).toContain("data_quality.step_coverage_days");
    expect(message).toContain("data_quality.readiness_coverage_days");
    expect(message).toContain("data_quality.sleep_coverage_days");
    expect(message).toContain("data_quality.tonal_volume");
    expect(message).toContain("Sound like a real coach reviewing the month");
    expect(message).toContain("Write like a clear monthly check-in");
    expect(message).toContain("do not imply the whole month lacks data");
    expect(message).toContain("Keep the age-100 objective in mind");
    expect(message).toContain("VOICE rewrite gate");
  });
});
