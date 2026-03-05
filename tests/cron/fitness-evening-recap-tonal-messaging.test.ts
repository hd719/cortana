import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Fitness Evening Recap Tonal tomorrow messaging", () => {
  it("includes explicit normal-vs-failure wording for tomorrow Tonal workout", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; payload?: { message?: string } }>;
    };

    const job = json.jobs.find((j) => j.id === "e4db8a8d-945c-4af2-a8d5-e54f2fb4e792");
    expect(job?.payload?.message).toBeTruthy();

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("For section D (Tomorrow Tonal workout):");
    expect(message).toContain("No Tonal workout scheduled for tomorrow.");
    expect(message).toContain("Couldn’t fetch upcoming Tonal schedule.");
    expect(message).toContain("If a metric is missing in other sections");
  });
});
