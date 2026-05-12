import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Morocco flight price watch cron contract", () => {
  it("allows a non-actionable browser snapshot when no Google Flights emails exist", () => {
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
    expect(message).toContain("one daily live browser price snapshot");
    expect(message).toContain("informational, not a setup action");
    expect(message).toContain("Rabat/RBA");
    expect(message).toContain("Aug 5-17 and Aug 7-17");
    expect(message).toContain("FLIGHT_PRICE_WATCH_BROWSER_BUDGET_MS=30000");
    expect(message).toContain("FLIGHT_PRICE_WATCH_CDP_RELOAD=auto");
    expect(message).toContain("FLIGHT_PRICE_WATCH_FLIGHT_NUMBER_LOOKUP=0");
    expect(message).toContain("bounded browser price snapshots");
    expect(message).toContain("visible airline/flight details");
    expect(message).toContain("preserve every configured route line");
    expect(message).toContain("Preserve all route lines exactly");
    expect(message).toContain("Gmail plus live Google Flights browser tabs");
    expect(message).toContain("If script outputs alert/snapshot/failure text: send it exactly once");
    expect(message).toContain("telegram target 8171372724 with accountId monitor");
    expect(job?.delivery).toMatchObject({ mode: "none", accountId: "monitor" });
    expect(job?.payload?.timeoutSeconds).toBe(120);
    expect(job?.payload?.lightContext).toBe(true);
  });
});
