import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sanitizeBranchToken(raw: string): string {
  return raw.replace(/^[*+\s]+/, "").trim();
}

describe("maintenance cron routing", () => {
  it("does not schedule the old repo auto-sync cron job", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; delivery?: { accountId?: string }; payload?: { message?: string } }>;
    };

    const job = json.jobs.find((j) => j.id === "49b29596-dd12-493d-820a-b3c234753783");
    expect(job).toBeUndefined();
  });

  it("gives the subagent reaper explicit Monitor ownership and quiet-path wording", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; delivery?: { accountId?: string }; payload?: { message?: string } }>;
    };

    const job = json.jobs.find((j) => j.id === "subagent-reliability-reaper-15m");
    expect(job?.payload?.message).toBeTruthy();
    expect(job?.delivery?.accountId).toBe("monitor");

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("Monitor is the user-facing owner lane for operational maintenance alerts");
    expect(message).toContain("Healthy/no-action paths must stay silent and return exactly `NO_REPLY`");
    expect(message).toContain("/Users/hd/Developer/cortana/tools/subagent-watchdog/check-subagents-with-retry.sh");
    expect(message).toContain("accountId: monitor");
    expect(message).toContain("return exactly `NO_REPLY`");
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
