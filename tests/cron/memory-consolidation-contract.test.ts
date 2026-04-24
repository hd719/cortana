import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("memory consolidation cron contract", () => {
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
    expect(job?.payload?.timeoutSeconds).toBe(300);
  });
});
