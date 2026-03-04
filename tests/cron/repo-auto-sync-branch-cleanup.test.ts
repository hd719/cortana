import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Repo Auto Sync branch cleanup command", () => {
  it("uses for-each-ref and avoids branch --merged parsing with current-branch marker", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; payload?: { message?: string } }>;
    };

    const job = json.jobs.find((j) => j.id === "49b29596-dd12-493d-820a-b3c234753783");
    expect(job?.payload?.message).toBeTruthy();

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("git for-each-ref --format='%(refname:short)' refs/heads --merged origin/main");
    expect(message).toContain('git branch -d -- "$b"');
    expect(message).not.toContain("git branch --merged origin/main | sed 's/*//'");
  });
});
