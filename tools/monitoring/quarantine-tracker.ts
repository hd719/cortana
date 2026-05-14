#!/usr/bin/env npx tsx
import fs from "fs";
import os from "os";
import path from "path";
import { runPsql, withPostgresPath } from "../lib/db.js";
import { PSQL_BIN } from "../lib/paths.js";
import { reportOperationalIssue } from "../github/issue-reporter.js";

const PATH_OVERRIDE = "/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin";

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function runSql(sql: string, dbName: string, env: NodeJS.ProcessEnv): string {
  const res = runPsql(sql, {
    db: dbName,
    args: ["-q", "-X", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) return "";
  return (res.stdout ?? "").toString().trim();
}

function insertEvent(
  dbName: string,
  env: NodeJS.ProcessEnv,
  source: string,
  severity: string,
  message: string,
  metadataJson: string
): void {
  const escMessage = sqlEscape(message);
  const escMeta = sqlEscape(metadataJson);
  runSql(
    `
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES ('quarantine_status', '${source}', '${severity}', '${escMessage}', '${escMeta}'::jsonb);
  `,
    dbName,
    env
  );
}

async function main(): Promise<number> {
  const env = withPostgresPath({ ...process.env, PATH: PATH_OVERRIDE });
  const psqlBin = process.env.PSQL_BIN ?? PSQL_BIN;
  const dbName = process.env.DB_NAME ?? "cortana";
  const source = "quarantine-tracker";
  const qdir = path.join(os.homedir(), ".openclaw", "cron", "quarantine");

  if (!isExecutable(psqlBin)) {
    process.stderr.write(`psql not executable at ${psqlBin}\n`);
    return 1;
  }

  fs.mkdirSync(qdir, { recursive: true });

  const nowEpoch = Math.floor(Date.now() / 1000);
  let totalQuarantined = 0;
  let longestDuration = 0;
  let longestJob = "";
  let issuesReported = 0;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(qdir).filter((entry) => entry.endsWith(".quarantined"));
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    const qfile = path.join(qdir, entry);
    if (!fs.existsSync(qfile)) continue;

    totalQuarantined += 1;
    const jobName = entry.replace(/\.quarantined$/, "");

    let mtimeEpoch = nowEpoch;
    try {
      mtimeEpoch = Math.floor(fs.statSync(qfile).mtimeMs / 1000);
    } catch {
      mtimeEpoch = nowEpoch;
    }
    if (!Number.isFinite(mtimeEpoch)) mtimeEpoch = nowEpoch;

    let durationSeconds = nowEpoch - mtimeEpoch;
    if (durationSeconds < 0) durationSeconds = 0;
    const durationHours = Math.floor(durationSeconds / 3600);

    if (durationSeconds > longestDuration) {
      longestDuration = durationSeconds;
      longestJob = jobName;
    }

    const title = `Investigate quarantined cron: ${jobName}`;
    let issueReportedForJob = 0;

    if (durationSeconds > 86400) {
      const result = reportOperationalIssue({
        title,
        summary: `Cron '${jobName}' has been quarantined for ${durationHours}h. Investigate the failing dependency and release quarantine safely.`,
        source,
        category: "cron-quarantine",
        severity: durationSeconds > 172800 ? "critical" : "warning",
        system: jobName,
        repoHint: "cortana",
        evidence: {
          job: jobName,
          quarantine_file: qfile,
          duration_seconds: durationSeconds,
          duration_hours: durationHours,
          trigger: ">24h_quarantine",
        },
        recommendedAction: "Inspect the quarantined cron's latest stderr/artifact, fix the durable failure, and remove the quarantine marker only after a passing manual run.",
      });
      if (result.status === "created" || result.status === "existing") {
        issuesReported += 1;
        issueReportedForJob = 1;
      }
    }

    const escJob = sqlEscape(jobName);
    let qCount24h = runSql(
      `SELECT COUNT(*) FROM cortana_events WHERE event_type='quarantine_status' AND metadata->>'job'='${escJob}' AND timestamp >= NOW() - INTERVAL '24 hours';`,
      dbName,
      env
    ).replace(/\s+/g, "");
    let qCount7d = runSql(
      `SELECT COUNT(*) FROM cortana_events WHERE event_type='quarantine_status' AND metadata->>'job'='${escJob}' AND timestamp >= NOW() - INTERVAL '7 days';`,
      dbName,
      env
    ).replace(/\s+/g, "");

    if (!/^[0-9]+$/.test(qCount24h)) qCount24h = "0";
    if (!/^[0-9]+$/.test(qCount7d)) qCount7d = "0";

    let severity = "info";
    if (durationSeconds > 172800) {
      severity = "critical";
    } else if (durationSeconds > 86400) {
      severity = "warning";
    }

    insertEvent(
      dbName,
      env,
      source,
      severity,
      `Quarantine active: ${jobName} (${durationHours}h)`,
      `{"job":"${jobName}","quarantine_file":"${qfile}","duration_seconds":${durationSeconds},"duration_hours":${durationHours},"quarantine_count_24h":${qCount24h},"quarantine_count_7d":${qCount7d},"github_issue_reported":${issueReportedForJob}}`
    );
  }

  if (totalQuarantined === 0) {
    insertEvent(dbName, env, source, "info", "No active quarantined cron jobs", "{\"total_quarantined\":0}");
  }

  const longestHours = Math.floor(longestDuration / 3600);
  if (totalQuarantined > 0) {
    console.log(
      `quarantine-tracker: total_quarantined=${totalQuarantined} longest_job=${longestJob} longest_duration_hours=${longestHours} github_issues_reported=${issuesReported}`
    );
  } else {
    console.log(
      "quarantine-tracker: total_quarantined=0 longest_duration_hours=0 github_issues_reported=0"
    );
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
