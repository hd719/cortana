import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sanitizeBranchToken(raw: string): string {
  return raw.replace(/^[*+\s]+/, "").trim();
}

describe("Repo Auto Sync branch cleanup command", () => {
  it("uses direct git hygiene flow with safe branch-state handling and local-only cleanup", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; payload?: { message?: string } }>;
    };

    const job = json.jobs.find((j) => j.id === "49b29596-dd12-493d-820a-b3c234753783");
    expect(job?.payload?.message).toBeTruthy();

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("without invoking external helper scripts");
    expect(message).toContain("git -C <repo> status --porcelain --untracked-files=all");
    expect(message).toContain("Dirty-state policy:");
    expect(message).toContain("EXPECTED / SILENT (return NO_REPLY for that repo)");
    expect(message).toContain("ACTIONABLE (report):");
    expect(message).toContain("git -C <repo> rev-list --left-right --count origin/main...HEAD");
    expect(message).toContain("feature-branch ahead state as expected and silent");
    expect(message).toContain("<repo> branch-state: diverged-manual-intervention-required");
    expect(message).toContain("delete merged local branches when safe");
    expect(message).toContain("return exactly NO_REPLY");
    expect(message).toContain("send ONE concise Telegram message via message tool");
    expect(message).not.toContain("bash /Users/hd/Developer/cortana/tools/repo/repo-auto-sync.sh");
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
