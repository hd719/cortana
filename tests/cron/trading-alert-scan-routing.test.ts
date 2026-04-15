import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("CANSLIM trading alert cron routing", () => {
  it("uses the unified compute-only cron wrapper with Monitor-owned delivery metadata", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{
        id?: string;
        delivery?: { accountId?: string };
        payload?: { message?: string; timeoutSeconds?: number };
      }>;
    };

    const job = json.jobs.find((entry) => entry.id === "9d2f7f92-b9e9-48bc-87b0-a5859bb83927");
    expect(job?.delivery?.accountId).toBe("monitor");
    expect(fs.existsSync("tools/trading/run-backtest-compute.sh")).toBe(true);

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("Cron A for the unified CANSLIM + Dip Buyer market-session pipeline");
    expect(message).toContain("must NOT send Telegram messages directly");
    expect(message).toContain("/Users/hd/Developer/cortana/tools/trading/run-backtest-compute.sh");
    expect(message).toContain("backtest-compute complete");
    expect(message).not.toContain("accountId: oracle");
    expect(message).not.toContain("canslim_alert.py --limit 8 --min-score 6");
    expect(message).not.toContain("Use the `message` tool");
    expect(job?.payload?.timeoutSeconds).toBe(1200);
  });
});
