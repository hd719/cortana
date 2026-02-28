#!/usr/bin/env npx tsx
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "../tools/lib/db.js";

const env = withPostgresPath(process.env);

function psqlText(sql: string): string {
  const res = runPsql(sql, { args: ["-X", "-q", "-t", "-A"], env });
  return (res.stdout ?? "").toString().trim();
}

function psqlExec(sql: string): void {
  void runPsql(sql, { args: ["-X", "-q"], env, stdio: "ignore" });
}

const current = psqlText("SELECT value::text FROM cortana_chief_model WHERE key='cortical_loop_enabled';").replace(/["\s]/g, "");

if (current === "true") {
  psqlExec("UPDATE cortana_chief_model SET value = '\"false\"', updated_at = NOW(), source = 'manual_toggle' WHERE key = 'cortical_loop_enabled';");
  console.log("Cortical Loop: DISABLED");
} else {
  psqlExec("UPDATE cortana_chief_model SET value = '\"true\"', updated_at = NOW(), source = 'manual_toggle' WHERE key = 'cortical_loop_enabled';");
  const dateRes = spawnSync("date", ["+%Y-%m-%d"], {
    env: { ...process.env, TZ: "America/New_York" },
    encoding: "utf8",
  });
  const today = (dateRes.stdout ?? "").toString().trim();
  psqlExec(`UPDATE cortana_chief_model SET value = jsonb_build_object('count', 0, 'date', '${today}', 'max', (SELECT (value->>'max')::int FROM cortana_chief_model WHERE key='daily_wake_count')), updated_at = NOW() WHERE key = 'daily_wake_count';`);
  console.log("Cortical Loop: ENABLED");
}
