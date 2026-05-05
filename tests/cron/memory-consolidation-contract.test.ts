import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("memory consolidation cron contract", () => {
  it("runs a deterministic daily-memory materializer before consolidation depends on root files", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{
        id?: string;
        name?: string;
        enabled?: boolean;
        schedule?: { kind?: string; expr?: string; tz?: string };
        payload?: { message?: string; timeoutSeconds?: number; lightContext?: boolean };
      }>;
    };

    const job = json.jobs.find((entry) => entry.id === "daily-memory-materializer-20260505");
    const message = String(job?.payload?.message ?? "");

    expect(job?.name).toBe("🧠 Daily Memory Materializer");
    expect(job?.enabled).toBe(true);
    expect(job?.schedule).toMatchObject({ kind: "cron", expr: "7 6-23 * * *", tz: "America/New_York" });
    expect(message).toContain("tools/memory/materialize-daily-memory.ts --today --yesterday");
    expect(message).toContain("First action must be one `exec` tool call");
    expect(job?.payload?.timeoutSeconds).toBe(180);
    expect(job?.payload?.lightContext).toBe(true);
  });

  it("returns NO_REPLY for no-op runs so completed work is not marked failed", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{
        id?: string;
        payload?: { message?: string; timeoutSeconds?: number };
      }>;
    };

    const job = json.jobs.find((entry) => entry.id === "f7414f95-7795-4e5f-81c6-034e9609cac6");
    const message = String(job?.payload?.message ?? "");

    expect(message).toContain("If no substantive change, return exactly NO_REPLY");
    expect(message).not.toContain("return NOTHING");
    expect(message).toContain("materialize-daily-memory.ts --today --yesterday");
    expect(message).toContain("only query columns that actually exist");
    expect(job?.payload?.timeoutSeconds).toBe(300);
  });
});
