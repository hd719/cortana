import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("morning brief cron contract", () => {
  it("forces the morning brief through the deterministic wrapper without generic filler", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; payload?: { message?: string; timeoutSeconds?: number } }>;
    };

    const job = json.jobs.find((entry) => entry.id === "489b1e20-1bb0-48e6-a388-c3cc1743a324");
    const message = String(job?.payload?.message ?? "");

    expect(job?.payload?.timeoutSeconds).toBe(120);
    expect(message).toContain("First action must be one `exec` tool call");
    expect(message).toContain("bash /Users/hd/Developer/cortana/tools/morning-brief/run-morning-brief.sh");
    expect(message).toContain("Google Calendar schedule");
    expect(message).toContain("open Apple Reminders in the Cortana list");
    expect(message).not.toContain("Today at a glance (3 bullets)");
    expect(message).not.toContain("Output format:");
  });
});
