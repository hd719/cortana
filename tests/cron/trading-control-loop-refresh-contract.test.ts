import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type CronJob = {
  id?: string;
  delivery?: { accountId?: string };
  schedule?: { kind?: string; expr?: string };
  payload?: { message?: string; timeoutSeconds?: number };
};

function minuteOfDay(expr: string | undefined): number | null {
  if (!expr) return null;
  const [minuteRaw, hourRaw] = expr.split(" ");
  const minute = Number(minuteRaw);
  const hour = Number(hourRaw.split(",")[0]);
  if (!Number.isFinite(minute) || !Number.isFinite(hour)) return null;
  return hour * 60 + minute;
}

describe("trading control-loop refresh cron contract", () => {
  it("schedules the weekday control-loop refresh after precompute and before market-session scans", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as { jobs: CronJob[] };

    const precompute = json.jobs.find((job) => job.id === "trading-precompute-20260319");
    const job = json.jobs.find((entry) => entry.id === "trading-control-loop-refresh-20260427");
    const marketScan = json.jobs.find((entry) => entry.id === "9d2f7f92-b9e9-48bc-87b0-a5859bb83927");

    expect(minuteOfDay(precompute?.schedule?.expr)).toBeLessThan(minuteOfDay(job?.schedule?.expr));
    expect(minuteOfDay(job?.schedule?.expr)).toBeLessThan(minuteOfDay(marketScan?.schedule?.expr));
    expect(job?.delivery?.accountId).toBe("monitor");
    expect(job?.schedule?.kind).toBe("cron");
    expect(job?.schedule?.expr).toBe("20 8 * * 1-5");
    expect(fs.existsSync("tools/trading/run-v4-control-loop-refresh.sh")).toBe(true);

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("V4 trading control-loop refresh lane");
    expect(message).toContain("/Users/hd/Developer/cortana/tools/trading/run-v4-control-loop-refresh.sh");
    expect(message).toContain("Fail the run if the control-loop schedule assertion is still late after refresh");
    expect(message).toContain("control-loop refresh complete");
    expect(job?.payload?.timeoutSeconds).toBe(600);
  });
});
