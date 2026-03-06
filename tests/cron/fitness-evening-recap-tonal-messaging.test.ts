import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Fitness Evening Recap Tonal tomorrow messaging", () => {
  it("enforces the current section D and missing-metric messaging contract", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; payload?: { message?: string } }>;
    };

    const job = json.jobs.find((j) => j.id === "e4db8a8d-945c-4af2-a8d5-e54f2fb4e792");
    expect(job?.payload?.message).toBeTruthy();

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("Output sections:");
    expect(message).toMatch(/D\)\s*Tomorrow Tonal workout/);
    expect(message).toContain('If no workouts today, explicitly say:');
    expect(message).toContain("Rest day — no workout logged today.");
    expect(message).toMatch(/If a metric is missing.*"Unavailable"/s);
    expect(message).toContain('Keep concise and useful; avoid repeating "N/A" across sections.');
  });
});
