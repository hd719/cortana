import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("trading re-check cron routing", () => {
  it("routes the bounded re-check through cron-market with Monitor-owned delivery", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{
        id?: string;
        agentId?: string;
        delivery?: { accountId?: string };
        schedule?: { kind?: string; expr?: string };
        payload?: { message?: string; timeoutSeconds?: number; };
      }>;
    };

    const job = json.jobs.find((entry) => entry.id === "trading-quick-recheck-20260319");
    expect(job?.agentId).toBe("cron-market");
    expect(job?.delivery?.accountId).toBe("monitor");
    expect(job?.schedule?.kind).toBe("cron");
    expect(job?.schedule?.expr).toBe("0 11,15 * * 1-5");
    expect(fs.existsSync("tools/trading/run-trading-recheck.sh")).toBe(true);

    const message = String(job?.payload?.message ?? "");
    expect(message).toContain("bounded quick-check re-check");
    expect(message).toContain("/Users/hd/Developer/cortana/tools/trading/run-trading-recheck.sh");
    expect(message).toContain("If script outputs exactly NO_REPLY");
    expect(message).toContain("accountId monitor");
    expect(job?.payload?.timeoutSeconds).toBe(300);
  });
});
