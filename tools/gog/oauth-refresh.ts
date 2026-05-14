#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { withPostgresPath } from "../lib/db.js";
import { PSQL_BIN } from "../lib/paths.js";
import { runGogWithEnv } from "./gog-with-env.js";
import { reportOperationalIssue } from "../github/issue-reporter.ts";

function sqlEscape(v: string): string {
  return (v || "").replace(/'/g, "''");
}

function run(
  cmd: string,
  args: string[],
  env = process.env,
): { rc: number; out: string; err: string } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function isLikelyKeyringFailure(text: string): boolean {
  return /keyring|list keyring keys|not valid \(-50\)|security:/i.test(text);
}

function isAuthFailure(text: string): boolean {
  return /auth|oauth|token|invalid_grant|unauthori[sz]ed|credential|login|consent|expired|reauth/i.test(
    text,
  );
}

function parseMetadata(meta: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(meta);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function runGog(
  args: string[],
  env = process.env,
): { rc: number; out: string; err: string } {
  const r = runGogWithEnv(args, env);
  return {
    rc: r.status ?? 1,
    out: String(r.stdout ?? ""),
    err: String(r.stderr ?? ""),
  };
}

function runCalendarProbe(
  account: string,
  calendarId: string,
  env = process.env,
) {
  return runGog(
    [
      "--account",
      account,
      "calendar",
      "events",
      calendarId,
      "--from",
      "today",
      "--to",
      "tomorrow",
      "--json",
      "--no-input",
    ],
    env,
  );
}

async function main(): Promise<void> {
  const db = process.env.CORTANA_DB || "cortana";
  const calendarId =
    process.env.GOG_OAUTH_CHECK_CALENDAR_ID ||
    "60e1d0b7ca7586249ee94341d65076f28d9b9f3ec67d89b0709371c0ff82d517@group.calendar.google.com";
  const account = process.env.GOG_ACCOUNT || "hameldesai3@gmail.com";
  const source = "gog-oauth-refresh";

  const env = withPostgresPath(process.env);

  const logEvent = (sev: string, msg: string, meta = "{}") => {
    const sql = `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('gog_oauth_refresh', '${source}', '${sev}', '${sqlEscape(msg)}', '${sqlEscape(meta)}'::jsonb);`;
    run(PSQL_BIN, [db, "-c", sql], env);
  };

  const createAlert = (title: string, desc: string, meta = "{}") => {
    reportOperationalIssue({
      title,
      summary: desc,
      source,
      category: "auth-expired",
      severity: "critical",
      system: "gog",
      repoHint: "cortana-external",
      evidence: {
        account,
        calendarId,
        metadata: parseMetadata(meta),
      },
      recommendedAction: "Reauthorize Gog locally, then rerun the calendar sync probe.",
    });
  };

  const resolveAlert = (_title: string, _meta = "{}") => {
    // GitHub Issues remain the durable queue; this script only emits health events.
  };

  let probe = runCalendarProbe(account, calendarId);
  let probeText = `${probe.out}${probe.err}`;

  if (probe.rc !== 0 && !isAuthFailure(probeText)) {
    for (let attempt = 0; attempt < 2 && probe.rc !== 0; attempt += 1) {
      probe = runCalendarProbe(account, calendarId);
      probeText = `${probe.out}${probe.err}`;
      if (probe.rc === 0 || isAuthFailure(probeText)) break;
    }
  }

  if (probe.rc === 0) {
    resolveAlert(
      "gog OAuth requires manual re-auth",
      `{"account":"${account}","calendarId":"${calendarId}","probe_rc":${probe.rc},"resolved_by":"${source}"}`,
    );
    logEvent(
      "info",
      "gog OAuth check passed",
      `{"account":"${account}","calendarId":"${calendarId}","probe_rc":${probe.rc}}`,
    );
    console.log("gog oauth ok");
    process.exit(0);
    return;
  }

  if (!isAuthFailure(probeText)) {
    logEvent(
      "error",
      "gog calendar probe failed (non-auth)",
      `{"account":"${account}","calendarId":"${calendarId}","probe_rc":${probe.rc},"error":"${sqlEscape(probeText)}"}`,
    );
    console.error(`gog oauth probe failed (non-auth): ${probeText}`);
    process.exit(1);
    return;
  }

  const authList = runGog(["auth", "list", "--json", "--no-input"]);
  const authListText = `${authList.out}${authList.err}`;
  if (authList.rc !== 0 && isLikelyKeyringFailure(authListText)) {
    const switchKeyring = runGog(["auth", "keyring", "file", "--no-input"]);
    const switchText = `${switchKeyring.out}${switchKeyring.err}`;
    if (switchKeyring.rc === 0) {
      const probeAfterKeyringSwitch = runCalendarProbe(account, calendarId);
      const probeAfterKeyringSwitchText = `${probeAfterKeyringSwitch.out}${probeAfterKeyringSwitch.err}`;
      if (probeAfterKeyringSwitch.rc === 0) {
        logEvent(
          "info",
          "gog auth recovered via keyring backend switch",
          `{"account":"${account}","calendarId":"${calendarId}"}`,
        );
        console.log("gog oauth recovered via keyring backend switch");
        process.exit(0);
        return;
      }
      logEvent(
        "error",
        "gog keyring backend switched but probe still failing",
        `{"account":"${account}","calendarId":"${calendarId}","probe_rc":${probeAfterKeyringSwitch.rc},"error":"${sqlEscape(probeAfterKeyringSwitchText)}"}`,
      );
    } else {
      logEvent(
        "error",
        "gog keyring backend switch failed",
        `{"account":"${account}","calendarId":"${calendarId}","error":"${sqlEscape(switchText)}"}`,
      );
    }
  }

  const guidance = `Manual re-auth required: run 'gog auth add ${account} --services calendar,gmail' and retry.`;
  logEvent(
    "error",
    "gog auth requires manual reauthorization",
    `{"account":"${account}","calendarId":"${calendarId}","probe_rc":${probe.rc},"error":"${sqlEscape(probeText)}"}`,
  );
  createAlert(
    "gog OAuth requires manual re-auth",
    guidance,
    `{"account":"${account}","calendarId":"${calendarId}","probe_rc":${probe.rc}}`,
  );
  console.error(`gog oauth auth-error: ${guidance} ${probeText}`);
  process.exit(1);
  return;
}

main();
