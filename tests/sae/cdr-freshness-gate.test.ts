import { afterEach, beforeEach, expect, it } from "vitest";
import { evaluateFreshnessGate } from "../../tools/sae/cdr-freshness-gate";
import { describeWithPostgres, probePostgres, psql } from "./db-test-utils";

const postgres = probePostgres();

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

describeWithPostgres(postgres)("cdr-freshness-gate", () => {
  beforeEach(() => {
    if (!postgres.ok) throw new Error(postgres.reason);
    psql("UPDATE cortana_sitrep_runs SET status = '_test_hidden' WHERE status = 'completed' AND run_id NOT LIKE 'gate-test-%';");
    psql("DELETE FROM cortana_sitrep_runs WHERE run_id LIKE 'gate-test-%';");
  });

  afterEach(() => {
    psql("DELETE FROM cortana_sitrep_runs WHERE run_id LIKE 'gate-test-%';");
    psql("UPDATE cortana_sitrep_runs SET status = 'completed' WHERE status = '_test_hidden';");
  });

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
    expect(["stale", "high_error_ratio"]).toContain(result.reason);
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
