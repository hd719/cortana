import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { evaluateFreshnessGate } from "../../tools/sae/cdr-freshness-gate";

const PSQL_BIN = process.env.PSQL_BIN || "/opt/homebrew/opt/postgresql@17/bin/psql";
const DB_NAME = process.env.DB_NAME || "cortana";

function psql(sql: string): string {
  const proc = spawnSync(PSQL_BIN, [DB_NAME, "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `/opt/homebrew/opt/postgresql@17/bin:${process.env.PATH ?? ""}`,
    },
  });
  if ((proc.status ?? 1) !== 0) {
    throw new Error((proc.stderr || proc.stdout || "psql failed").trim());
  }
  return (proc.stdout || "").trim();
}

function seedRun(args: {
  runId: string;
  completedAt: string;
  errorCount: number;
  totalKeys: number;
  expectedDomains: string[];
  actualDomains: string[];
}) {
  const exp = `ARRAY[${args.expectedDomains.map((d) => `'${d}'`).join(",")}]::text[]`;
  const act = `ARRAY[${args.actualDomains.map((d) => `'${d}'`).join(",")}]::text[]`;
  psql(`
    INSERT INTO cortana_sitrep_runs (run_id, started_at, completed_at, status, expected_domains, actual_domains, total_keys, error_count)
    VALUES ('${args.runId}', NOW() - INTERVAL '2 hours', '${args.completedAt}'::timestamptz, 'completed', ${exp}, ${act}, ${args.totalKeys}, ${args.errorCount})
    ON CONFLICT (run_id) DO UPDATE SET
      completed_at = EXCLUDED.completed_at,
      status = EXCLUDED.status,
      expected_domains = EXCLUDED.expected_domains,
      actual_domains = EXCLUDED.actual_domains,
      total_keys = EXCLUDED.total_keys,
      error_count = EXCLUDED.error_count;
  `);
}

// Hide all production completed runs before each test, restore after
beforeEach(() => {
  psql("UPDATE cortana_sitrep_runs SET status = '_test_hidden' WHERE status = 'completed' AND run_id NOT LIKE 'gate-test-%';");
  psql("DELETE FROM cortana_sitrep_runs WHERE run_id LIKE 'gate-test-%';");
});

afterEach(() => {
  psql("DELETE FROM cortana_sitrep_runs WHERE run_id LIKE 'gate-test-%';");
  psql("UPDATE cortana_sitrep_runs SET status = 'completed' WHERE status = '_test_hidden';");
});

describe("cdr-freshness-gate", () => {
  it("fails when no completed runs exist", () => {
    const result = evaluateFreshnessGate(new Date());
    expect(result.shouldProceed).toBe(false);
    expect(result.reason).toBe("no_completed_run");
  });

  it("passes on fresh, healthy, sufficiently-covered run", () => {
    seedRun({
      runId: "gate-test-fresh",
      completedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      totalKeys: 20,
      errorCount: 2,
      expectedDomains: ["calendar", "email", "weather", "health"],
      actualDomains: ["calendar", "email", "weather", "health"],
    });

    const result = evaluateFreshnessGate(new Date());
    expect(result.shouldProceed).toBe(true);
    expect(result.reason).toBe("ok");
  });

  it("fails on stale run", () => {
    seedRun({
      runId: "gate-test-stale",
      completedAt: new Date(Date.now() - 200 * 60 * 1000).toISOString(),
      totalKeys: 20,
      errorCount: 2,
      expectedDomains: ["calendar", "email", "weather", "health"],
      actualDomains: ["calendar", "email", "weather", "health"],
    });

    const result = evaluateFreshnessGate(new Date());
    expect(result.shouldProceed).toBe(false);
    expect(result.reason).toBe("stale");
  });

  it("fails on high error ratio", () => {
    seedRun({
      runId: "gate-test-errors",
      completedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      totalKeys: 10,
      errorCount: 5,
      expectedDomains: ["calendar", "email", "weather", "health"],
      actualDomains: ["calendar", "email", "weather", "health"],
    });

    const result = evaluateFreshnessGate(new Date());
    expect(result.shouldProceed).toBe(false);
    expect(result.reason).toBe("high_error_ratio");
  });
});
