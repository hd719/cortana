import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Fitness Evening Recap Tonal tomorrow messaging", () => {
  it("uses artifact-driven hard-truth contract and scoped insight updates", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; payload?: { message?: string } }>;
    };

    const job = json.jobs.find((j) => j.id === "e4db8a8d-945c-4af2-a8d5-e54f2fb4e792");
    expect(job?.payload?.message).toBeTruthy();

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("/Users/hd/Developer/cortana/tools/fitness/evening-recap-data.ts");
    expect(message).toContain("/Users/hd/Developer/cortana/identities/spartan/VOICE.md");
    expect(message).toContain("today_training_output");
    expect(message).toContain("cycle-first");
    expect(message).toContain("Start with the day’s load verdict in natural language");
    expect(message).toContain("today_nutrition");
    expect(message).toContain("nutrition_assumption");
    expect(message).toContain("tonight_sleep_target");
    expect(message).toContain("Sound like a real coach following up after the day");
    expect(message).toContain("Write like a text follow-up, not a summary report");
    expect(message).toContain("Finish with one concrete action for tonight");
    expect(message).toContain("VOICE rewrite gate");
    expect(message).toContain("Do not call evening load signal \"readiness\"");
    expect(message).toContain("Keep the age-100 objective in mind");
    expect(message).toContain("do not stop at \"unknown\"");
    expect(message).toContain("Do not rehash morning readiness details or weekly trends");
    expect(message).toContain("pending_health_insights");
    expect(message).toContain("insight_mark_sql");
    expect(message).not.toContain("acted_on = TRUE, acted_at = NOW() WHERE acted_on = FALSE");
  });
});
