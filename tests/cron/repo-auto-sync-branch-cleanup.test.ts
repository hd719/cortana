import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sanitizeBranchToken(raw: string): string {
  return raw.replace(/^[*+\s]+/, "").trim();
}

describe("Repo Auto Sync branch cleanup command", () => {
  it("uses script-based fail-fast hygiene flow with safe ordering and local-only cleanup", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; payload?: { message?: string } }>;
    };

    const job = json.jobs.find((j) => j.id === "49b29596-dd12-493d-820a-b3c234753783");
    expect(job?.payload?.message).toBeTruthy();

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("bash /Users/hd/Developer/cortana/tools/repo/repo-auto-sync.sh");
    expect(message).toContain("Fail fast on dirty/untracked preflight");
    expect(message).toContain("If stash entries exist, log snapshot metadata and continue safely (non-destructive)");
    expect(message).toContain("preflight cleanliness -> pull -> local merged-branch cleanup");
    expect(message).toContain("Delete only LOCAL branches merged into origin/main (never remote delete)");
    expect(message).toContain("checked out in a temp worktree (/tmp or /private/tmp): auto-stash dirty changes (include untracked) with timestamped message, remove the temp worktree, then delete the branch");
    expect(message).toContain("Never auto-remove non-temp external worktrees; skip with warning");
    expect(message).not.toContain("git clean -fd");
  });

  it("sanitizes marker-prefixed branch tokens (regression for '+ fix/...')", () => {
    const tokens = [
      "* main",
      "+ fix/dipbuyer-degraded-rate-limit",
      "  feature/clean-tokenizer  ",
      "+",
      " * ",
      "",
    ];

    const cleaned = tokens.map(sanitizeBranchToken).filter(Boolean);

    expect(cleaned).toEqual([
      "main",
      "fix/dipbuyer-degraded-rate-limit",
      "feature/clean-tokenizer",
    ]);
    expect(cleaned).not.toContain("+ fix/dipbuyer-degraded-rate-limit");
  });
});
