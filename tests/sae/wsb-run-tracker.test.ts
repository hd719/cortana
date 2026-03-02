import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { completeRun, getLatestCompletedRun, startRun } from "../../tools/sae/wsb-run-tracker";

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

function esc(v: string): string {
  return v.replace(/'/g, "''");
}

beforeAll(() => {
  const path = require("node:path");
  const migrationsDir = path.resolve(__dirname, "../../migrations");

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
});

describe("sae migration", () => {
  it("applies cleanly and creates required objects", () => {
    const tableName = psql("SELECT to_regclass('public.cortana_sitrep_runs')::text;");
    const viewName = psql("SELECT to_regclass('public.cortana_sitrep_latest_completed')::text;");
    expect(tableName).toBe("cortana_sitrep_runs");
    expect(viewName).toBe("cortana_sitrep_latest_completed");
  });
});

describe("wsb-run-tracker", () => {
  beforeEach(() => {
    psql("UPDATE cortana_sitrep_runs SET status = '_test_hidden' WHERE status = 'completed' AND run_id NOT LIKE 'wsb-test-%';");
  });

  afterEach(() => {
    psql("UPDATE cortana_sitrep_runs SET status = 'completed' WHERE status = '_test_hidden';");
  });

  it("startRun inserts metadata row and completeRun updates stats", () => {
    const runId = `11111111-1111-4111-8111-${Date.now().toString().slice(-12)}`;
    const expected = ["calendar", "email", "weather"];

    startRun(runId, expected);

    psql(`
      INSERT INTO cortana_sitrep (run_id, domain, key, value)
      VALUES
        ('${esc(runId)}'::uuid, 'calendar', 'events_48h', '{"count":2}'::jsonb),
        ('${esc(runId)}'::uuid, 'email', 'error_fetch', '{"message":"timeout"}'::jsonb),
        ('${esc(runId)}'::uuid, 'weather', 'today', '{"temp":65}'::jsonb);
    `);

    completeRun(runId);

    const row = psql(`
      SELECT status || '|' || COALESCE(total_keys::text,'') || '|' || COALESCE(error_count::text,'') || '|' || COALESCE(array_length(actual_domains,1)::text,'0')
      FROM cortana_sitrep_runs
      WHERE run_id='${esc(runId)}';
    `);

    expect(row).toContain("partial|3|1|3");
  });

  it("getLatestCompletedRun returns most recent completed metadata", () => {
    // Insert a clean completed run (no errors, all domains present)
    const suffix = Date.now().toString().slice(-12);
    const runId = `22222222-2222-4222-8222-${suffix}`;
    startRun(runId, ["calendar", "email"]);
    psql(`
      INSERT INTO cortana_sitrep (run_id, domain, key, value)
      VALUES
        ('${esc(runId)}'::uuid, 'calendar', 'events_48h', '{"count":2}'::jsonb),
        ('${esc(runId)}'::uuid, 'email', 'inbox', '{"count":5}'::jsonb);
    `);
    completeRun(runId);

    const run = getLatestCompletedRun();
    expect(run).not.toBeNull();
    expect(run?.status).toBe("completed");
    expect(typeof run?.run_id).toBe("string");
  });
});
