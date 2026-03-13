import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Daily Upgrade Protocol input validation contract", () => {
  it("requires preflight input checks and explicit missing-input bailout behavior", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; payload?: { message?: string } }>;
    };

    const job = json.jobs.find((j) => j.id === "f47d5170-112d-473c-9c4a-d51662688899");
    expect(job?.payload?.message).toBeTruthy();

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("Input validation + path resolution (MANDATORY, do before analysis):");
    expect(message).toContain("Resolve base paths from /Users/hd/Developer/cortana (repo-relative only; do not hardcode alternate roots).");
    expect(message).toContain("Resolve yesterday memory with a date glob: memory/YYYY-MM-DD.md (yesterday), not a single hardcoded filename.");
    expect(message).toContain("If ANY required input is missing/unreadable:");
    expect(message).toContain("Bail out early (no generic proposal).");
    expect(message).toContain("Emit explicit failure log with exact missing path(s) + error (e.g., ENOENT).");
    expect(message).toContain("Send concise Telegram alert that Daily Upgrade was skipped due to missing inputs.");
  });
});
