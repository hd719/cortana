import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Daily Upgrade Protocol input validation contract", () => {
  it("keeps the deleted Daily Upgrade cron out of the active config", () => {
    const jobsPath = path.resolve("config/cron/jobs.json");
    const raw = fs.readFileSync(jobsPath, "utf8");
    const json = JSON.parse(raw) as {
      jobs: Array<{ id?: string; name?: string; payload?: { message?: string } }>;
    };

    const byId = json.jobs.find((j) => j.id === "f47d5170-112d-473c-9c4a-d51662688899");
    const byName = json.jobs.find((j) => j.name === "🔧 Daily Upgrade Protocol");

    expect(byId).toBeUndefined();
    expect(byName).toBeUndefined();
  });
});
