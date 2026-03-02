import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { complete, start } from "../tools/sae/wsb-run-tracker";
import { evaluateFreshnessGate as evaluateGate } from "../tools/sae/cdr-freshness-gate";

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

function applyMigration(): void {
  const path = require("node:path");
  const migrationsDir = path.resolve(__dirname, "../migrations");

  // Apply base table first
  const base = path.join(migrationsDir, "000_cortana_sitrep.sql");
  const baseProc = spawnSync(PSQL_BIN, [DB_NAME, "-X", "-v", "ON_ERROR_STOP=1", "-f", base], {
    encoding: "utf8",
    env: { ...process.env, PATH: `/opt/homebrew/opt/postgresql@17/bin:${process.env.PATH ?? ""}` },
  });
  if ((baseProc.status ?? 1) !== 0) {
    throw new Error((baseProc.stderr || baseProc.stdout || "base migration failed").trim());
  }

  const migration = path.join(migrationsDir, "001_sae_sitrep_run_consistency.sql");
  const proc = spawnSync(PSQL_BIN, [DB_NAME, "-X", "-v", "ON_ERROR_STOP=1", "-f", migration], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `/opt/homebrew/opt/postgresql@17/bin:${process.env.PATH ?? ""}`,
    },
  });
  if ((proc.status ?? 1) !== 0) {
    throw new Error((proc.stderr || proc.stdout || "migration apply failed").trim());
  }
}

function esc(v: string): string {
  return v.replace(/'/g, "''");
}

beforeAll(() => {
  applyMigration();
});

describe("SAE pipeline hardening", () => {
  it("WSB run tracker start/complete stores run stats", () => {
    const suffix = Date.now().toString().slice(-12);
    const runId = `11111111-1111-4111-8111-${suffix}`;

    start(runId, ["calendar", "email", "weather"]);

    psql(`
      INSERT INTO cortana_sitrep (run_id, domain, key, value)
      VALUES
        ('${esc(runId)}'::uuid, 'calendar', 'events_48h', '{"count":2}'::jsonb),
        ('${esc(runId)}'::uuid, 'email', 'error_inbox', '{"message":"timeout"}'::jsonb),
        ('${esc(runId)}'::uuid, 'weather', 'today', '{"temp":65}'::jsonb);
    `);

    complete(runId);

    const row = psql(`
      SELECT COALESCE(total_keys::text,'') || '|' || COALESCE(error_count::text,'') || '|' || COALESCE(array_length(actual_domains,1)::text,'0')
      FROM cortana_sitrep_runs
      WHERE run_id='${esc(runId)}';
    `);

    expect(row).toBe("3|1|3");
  });

  describe("CDR freshness gate", () => {
    beforeEach(() => {
      psql("UPDATE cortana_sitrep_runs SET status = '_test_hidden' WHERE status = 'completed' AND run_id NOT LIKE 'test-sae-gate-%';");
      psql("DELETE FROM cortana_sitrep_runs WHERE run_id LIKE 'test-sae-gate-%';");
    });

    afterEach(() => {
      psql("DELETE FROM cortana_sitrep_runs WHERE run_id LIKE 'test-sae-gate-%';");
      psql("UPDATE cortana_sitrep_runs SET status = 'completed' WHERE status = '_test_hidden';");
    });

    it("CDR freshness gate passes for fresh completed run", () => {
      const runId = `test-sae-gate-fresh-${Date.now()}`;

      psql(`
        INSERT INTO cortana_sitrep_runs (run_id, status, completed_at, actual_domains, total_keys, error_count)
        VALUES ('${esc(runId)}', 'completed', TIMESTAMPTZ '2100-01-01 00:00:00+00', ARRAY['calendar','email','weather','health']::text[], 10, 2)
        ON CONFLICT (run_id) DO UPDATE SET
          status='completed',
          completed_at=EXCLUDED.completed_at,
          actual_domains=EXCLUDED.actual_domains,
          total_keys=EXCLUDED.total_keys,
          error_count=EXCLUDED.error_count;
      `);

      const result = evaluateGate(new Date("2100-01-01T00:30:00Z"));
      expect(result.shouldProceed).toBe(true);
      expect(result.reason).toBe("ok");
    });

    it("CDR freshness gate fails for stale run", () => {
      const runId = `test-sae-gate-stale-${Date.now()}`;

      psql(`
        INSERT INTO cortana_sitrep_runs (run_id, status, completed_at, actual_domains, total_keys, error_count)
        VALUES ('${esc(runId)}', 'completed', TIMESTAMPTZ '2100-01-01 00:00:00+00', ARRAY['calendar','email','weather','health']::text[], 10, 1)
        ON CONFLICT (run_id) DO UPDATE SET
          status='completed',
          completed_at=EXCLUDED.completed_at,
          actual_domains=EXCLUDED.actual_domains,
          total_keys=EXCLUDED.total_keys,
          error_count=EXCLUDED.error_count;
      `);

      const result = evaluateGate(new Date("2100-01-01T02:31:00Z"));
      expect(result.shouldProceed).toBe(false);
      expect(result.reason).toBe("stale");
    });

    it("CDR freshness gate fails for high error ratio", () => {
      const runId = `test-sae-gate-errors-${Date.now()}`;

      psql(`
        INSERT INTO cortana_sitrep_runs (run_id, status, completed_at, actual_domains, total_keys, error_count)
        VALUES ('${esc(runId)}', 'completed', TIMESTAMPTZ '2100-01-01 00:00:00+00', ARRAY['calendar','email','weather','health']::text[], 10, 3)
        ON CONFLICT (run_id) DO UPDATE SET
          status='completed',
          completed_at=EXCLUDED.completed_at,
          actual_domains=EXCLUDED.actual_domains,
          total_keys=EXCLUDED.total_keys,
          error_count=EXCLUDED.error_count;
      `);

      const result = evaluateGate(new Date("2100-01-01T00:30:00Z"));
      expect(result.shouldProceed).toBe(false);
      expect(result.reason).toBe("high_error_ratio");
    });
  });
});
