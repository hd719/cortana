import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sanitizeBranchToken(raw: string): string {
  return raw.replace(/^[*+\s]+/, "").trim();
}

describe("Repo Auto Sync branch cleanup command", () => {
  it("routes through the local repo hygiene tool with Monitor ownership and quiet healthy paths", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; delivery?: { accountId?: string }; payload?: { message?: string } }>;
    };

    const job = json.jobs.find((j) => j.id === "49b29596-dd12-493d-820a-b3c234753783");
    expect(job?.payload?.message).toBeTruthy();
    expect(job?.delivery?.accountId).toBe("monitor");

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("/Users/hd/Developer/cortana/tools/repo/repo-auto-sync.sh");
    expect(message).toContain("accountId: monitor");
    expect(message).toContain("safe/reversible cases");
    expect(message).toContain("merged local branches");
    expect(message).toContain("obvious /tmp worktrees");
    expect(message).toContain("volatile runtime-state false alarms");
    expect(message).toContain("return exactly NO_REPLY");
    expect(message).toContain("send it exactly once as a Monitor-owned maintenance alert");
    expect(message).not.toContain("git clean -fd");
    expect(message).not.toContain("push --delete");
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
