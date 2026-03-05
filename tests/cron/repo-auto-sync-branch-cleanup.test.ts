import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sanitizeBranchToken(raw: string): string {
  return raw.replace(/^[*+\s]+/, "").trim();
}

describe("Repo Auto Sync branch cleanup command", () => {
  it("uses for-each-ref and avoids branch --merged parsing with current/worktree markers", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; payload?: { message?: string } }>;
    };

    const job = json.jobs.find((j) => j.id === "49b29596-dd12-493d-820a-b3c234753783");
    expect(job?.payload?.message).toBeTruthy();

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("do not wrap command text in quotes");
    expect(message).toContain("git for-each-ref --format='%(refname:short)' refs/heads --merged origin/main");
    expect(message).toContain("sed -E 's/^[*+[:space:]]+//'");
    expect(message).toContain('git check-ref-format --branch "$b"');
    expect(message).toContain('git branch -d -- "$b"');
    expect(message).not.toContain("git branch --merged origin/main | sed 's/*//'");
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
