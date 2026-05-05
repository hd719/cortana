import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Morocco flight price watch cron contract", () => {
  it("sends deduped status text when no Google Flights emails exist", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{
        id?: string;
        name?: string;
        payload?: { message?: string; timeoutSeconds?: number; lightContext?: boolean };
        delivery?: { accountId?: string; mode?: string };
      }>;
    };

    const job = json.jobs.find((entry) => entry.id === "e573f6ae-9830-4b18-b785-2de842ed5795");
    const message = String(job?.payload?.message ?? "");

    expect(job?.name).toBe("✈️ Morocco Flight Price Watch");
    expect(message).toContain("daily setup-status dedupe");
    expect(message).toContain("If script outputs alert/status text: send it exactly once");
    expect(message).toContain("telegram target 8171372724 with accountId monitor");
    expect(job?.delivery).toMatchObject({ mode: "none", accountId: "monitor" });
    expect(job?.payload?.timeoutSeconds).toBe(90);
    expect(job?.payload?.lightContext).toBe(true);
  });
});
