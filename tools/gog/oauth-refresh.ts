#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import db from "../lib/db.js";
const { withPostgresPath } = db;
import { PSQL_BIN } from "../lib/paths.js";

function sqlEscape(v: string): string {
  return (v || "").replace(/'/g, "''");
}

function run(cmd: string, args: string[], env = process.env): { rc: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

async function main(): Promise<void> {
  const db = process.env.CORTANA_DB || "cortana";
  const calName = process.env.GOG_OAUTH_CHECK_CALENDAR || "Clawdbot-Calendar";
  const account = process.env.GOG_ACCOUNT || "hameldesai3@gmail.com";
  const source = "gog-oauth-refresh";

  const env = withPostgresPath(process.env);

  const logEvent = (sev: string, msg: string, meta = "{}") => {
    const sql = `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('gog_oauth_refresh', '${source}', '${sev}', '${sqlEscape(msg)}', '${sqlEscape(meta)}'::jsonb);`;
    run(PSQL_BIN, [db, "-c", sql], env);
  };

  const createAlert = (title: string, desc: string, meta = "{}") => {
    const sql = `INSERT INTO cortana_tasks (source, title, description, priority, status, auto_executable, execution_plan, metadata) VALUES ('${source}', '${sqlEscape(title)}', '${sqlEscape(desc)}', 1, 'ready', FALSE, 'Investigate gog OAuth auth failure and re-authorize if needed.', '${sqlEscape(meta)}'::jsonb);`;
    run(PSQL_BIN, [db, "-c", sql], env);
  };

  const probe = run("gog", ["--account", account, "cal", "list", calName, "--from", "today", "--plain", "--no-input"]);
  const probeText = `${probe.out}${probe.err}`;

  if (probe.rc === 0) {
    logEvent("info", "gog OAuth check passed", `{"account":"${account}","calendar":"${calName}","probe_rc":${probe.rc}}`);
    console.log("gog oauth ok");
    process.exit(0);
  }

  if (!/auth|oauth|token|invalid_grant|unauthori[sz]ed|credential|login|consent|expired|reauth/i.test(probeText)) {
    logEvent("error", "gog calendar probe failed (non-auth)", `{"account":"${account}","calendar":"${calName}","probe_rc":${probe.rc},"error":"${sqlEscape(probeText)}"}`);
    console.error(`gog oauth probe failed (non-auth): ${probeText}`);
    process.exit(1);
  }

  const help = run("gog", ["auth", "--help"]);
  if (!/^\s+refresh(\s|$)/m.test(`${help.out}${help.err}`)) {
    logEvent("error", "gog auth refresh subcommand unavailable", `{"account":"${account}","calendar":"${calName}","probe_rc":${probe.rc},"error":"${sqlEscape(probeText)}"}`);
    createAlert("gog OAuth refresh unavailable", "gog auth probe failed with auth error, but 'gog auth refresh' is not available in this gog build.", `{"account":"${account}","calendar":"${calName}","probe_rc":${probe.rc}}`);
    console.error("gog oauth auth-error; refresh command unavailable");
    process.exit(1);
  }

  const refresh = run("gog", ["--account", account, "auth", "refresh", "--no-input"]);
  const refreshText = `${refresh.out}${refresh.err}`;
  if (refresh.rc !== 0) {
    logEvent("error", "gog auth refresh failed", `{"account":"${account}","calendar":"${calName}","refresh_rc":${refresh.rc},"error":"${sqlEscape(refreshText)}"}`);
    createAlert("gog OAuth refresh failed", "gog auth probe failed and refresh attempt did not recover auth.", `{"account":"${account}","calendar":"${calName}","refresh_rc":${refresh.rc}}`);
    console.error(`gog oauth refresh failed: ${refreshText}`);
    process.exit(1);
  }

  const probe2 = run("gog", ["--account", account, "cal", "list", calName, "--from", "today", "--plain", "--no-input"]);
  const probe2Text = `${probe2.out}${probe2.err}`;
  if (probe2.rc === 0) {
    logEvent("info", "gog auth refresh succeeded", `{"account":"${account}","calendar":"${calName}"}`);
    console.log("gog oauth refreshed");
    process.exit(0);
  }

  logEvent("error", "gog auth refresh completed but probe still failing", `{"account":"${account}","calendar":"${calName}","probe_rc":${probe2.rc},"error":"${sqlEscape(probe2Text)}"}`);
  createAlert("gog OAuth still failing after refresh", "Refresh command returned success but auth probe still fails.", `{"account":"${account}","calendar":"${calName}","probe_rc":${probe2.rc}}`);
  console.error(`gog oauth still failing after refresh: ${probe2Text}`);
  process.exit(1);
}

main();
