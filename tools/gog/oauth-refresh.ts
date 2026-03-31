#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { withPostgresPath } from "../lib/db.js";
import { PSQL_BIN } from "../lib/paths.js";

function sqlEscape(v: string): string {
  return (v || "").replace(/'/g, "''");
}

function run(cmd: string, args: string[], env = process.env): { rc: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function isLikelyKeyringFailure(text: string): boolean {
  return /keyring|list keyring keys|not valid \(-50\)|security:/i.test(text);
}

function isAuthFailure(text: string): boolean {
  return /auth|oauth|token|invalid_grant|unauthori[sz]ed|credential|login|consent|expired|reauth/i.test(text);
}

function runCalendarProbe(account: string, calName: string) {
  return run("gog", ["--account", account, "cal", "list", calName, "--from", "today", "--plain", "--no-input"]);
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

  let probe = runCalendarProbe(account, calName);
  let probeText = `${probe.out}${probe.err}`;

  if (probe.rc !== 0 && !isAuthFailure(probeText)) {
    for (let attempt = 0; attempt < 2 && probe.rc !== 0; attempt += 1) {
      probe = runCalendarProbe(account, calName);
      probeText = `${probe.out}${probe.err}`;
      if (probe.rc === 0 || isAuthFailure(probeText)) break;
    }
  }

  if (probe.rc === 0) {
    logEvent("info", "gog OAuth check passed", `{"account":"${account}","calendar":"${calName}","probe_rc":${probe.rc}}`);
    console.log("gog oauth ok");
    process.exit(0);
  }

  if (!isAuthFailure(probeText)) {
    logEvent("error", "gog calendar probe failed (non-auth)", `{"account":"${account}","calendar":"${calName}","probe_rc":${probe.rc},"error":"${sqlEscape(probeText)}"}`);
    console.error(`gog oauth probe failed (non-auth): ${probeText}`);
    process.exit(1);
  }

  const authList = run("gog", ["auth", "list", "--json", "--no-input"]);
  const authListText = `${authList.out}${authList.err}`;
  if (authList.rc !== 0 && isLikelyKeyringFailure(authListText)) {
    const switchKeyring = run("gog", ["auth", "keyring", "file", "--no-input"]);
    const switchText = `${switchKeyring.out}${switchKeyring.err}`;
    if (switchKeyring.rc === 0) {
      const probeAfterKeyringSwitch = run("gog", ["--account", account, "cal", "list", calName, "--from", "today", "--plain", "--no-input"]);
      const probeAfterKeyringSwitchText = `${probeAfterKeyringSwitch.out}${probeAfterKeyringSwitch.err}`;
      if (probeAfterKeyringSwitch.rc === 0) {
        logEvent("info", "gog auth recovered via keyring backend switch", `{"account":"${account}","calendar":"${calName}"}`);
        console.log("gog oauth recovered via keyring backend switch");
        process.exit(0);
      }
      logEvent("error", "gog keyring backend switched but probe still failing", `{"account":"${account}","calendar":"${calName}","probe_rc":${probeAfterKeyringSwitch.rc},"error":"${sqlEscape(probeAfterKeyringSwitchText)}"}`);
    } else {
      logEvent("error", "gog keyring backend switch failed", `{"account":"${account}","calendar":"${calName}","error":"${sqlEscape(switchText)}"}`);
    }
  }

  const guidance = `Manual re-auth required: run 'gog auth add ${account} --services calendar,gmail' and retry.`;
  logEvent("error", "gog auth requires manual reauthorization", `{"account":"${account}","calendar":"${calName}","probe_rc":${probe.rc},"error":"${sqlEscape(probeText)}"}`);
  createAlert("gog OAuth requires manual re-auth", guidance, `{"account":"${account}","calendar":"${calName}","probe_rc":${probe.rc}}`);
  console.error(`gog oauth auth-error: ${guidance} ${probeText}`);
  process.exit(1);
}

main();
