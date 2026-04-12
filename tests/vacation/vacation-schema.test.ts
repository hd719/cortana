import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(process.cwd(), "migrations", "004_vacation_ops_mode.sql");

describe("vacation migration", () => {
  it("defines the canonical vacation tables and active-window uniqueness guard", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cortana_vacation_windows");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cortana_vacation_runs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cortana_vacation_check_results");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cortana_vacation_incidents");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cortana_vacation_actions");
    expect(sql).toContain("idx_cortana_vacation_windows_single_active");
    expect(sql).toContain("WHERE status = 'active'");
  });

  it("keeps the migration additive and idempotent", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS");
  });
});
