#!/usr/bin/env npx tsx
import fs from "fs";
import os from "os";
import path from "path";
import db from "../lib/db.js";
const { runPsql, withPostgresPath } = db;
import { PSQL_BIN } from "../lib/paths.js";

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

function findOpenTaskId(dbName: string, env: NodeJS.ProcessEnv, title: string): string {
  const escTitle = sqlEscape(title);
  return runSql(
    `
    SELECT id
    FROM cortana_tasks
    WHERE title = '${escTitle}'
      AND status IN ('ready','in_progress','blocked')
    ORDER BY created_at DESC
    LIMIT 1;
  `,
    dbName,
    env
  ).replace(/\s+/g, "");
}

function createTask(
  dbName: string,
  env: NodeJS.ProcessEnv,
  source: string,
  title: string,
  description: string,
  metadataJson: string
): void {
  const escTitle = sqlEscape(title);
  const escDesc = sqlEscape(description);
  const escMeta = sqlEscape(metadataJson);
  runSql(
    `
    INSERT INTO cortana_tasks (
      source, title, description, priority, status, assigned_to, metadata
    ) VALUES (
      '${source}', '${escTitle}', '${escDesc}', 2, 'ready', 'monitor', '${escMeta}'::jsonb
    );
  `,
    dbName,
    env
  );
}

function escalateTaskPriority(dbName: string, env: NodeJS.ProcessEnv, source: string, taskId: string): void {
  runSql(
    `
    UPDATE cortana_tasks
    SET priority = 1,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'escalated_by', '${source}',
          'escalated_at', NOW()
        )
    WHERE id = ${taskId}
      AND priority > 1;
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
  let newTasks = 0;
  let escalatedTasks = 0;

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
    let openTaskId = findOpenTaskId(dbName, env, title);

    let createdTaskForJob = 0;
    let escalatedTaskForJob = 0;

    if (durationSeconds > 86400 && !openTaskId) {
      createTask(
        dbName,
        env,
        source,
        title,
        `Cron '${jobName}' has been quarantined for ${durationHours}h. Investigate failing preflight dependency and release quarantine safely.`,
        `{"job":"${jobName}","quarantine_file":"${qfile}","duration_seconds":${durationSeconds},"trigger":">24h_quarantine"}`
      );
      openTaskId = findOpenTaskId(dbName, env, title);
      if (openTaskId) {
        newTasks += 1;
        createdTaskForJob = 1;
      }
    }

    if (durationSeconds > 172800 && openTaskId) {
      const beforePriority = runSql(
        `SELECT priority FROM cortana_tasks WHERE id = ${openTaskId};`,
        dbName,
        env
      ).replace(/\s+/g, "");
      escalateTaskPriority(dbName, env, source, openTaskId);
      const afterPriority = runSql(
        `SELECT priority FROM cortana_tasks WHERE id = ${openTaskId};`,
        dbName,
        env
      ).replace(/\s+/g, "");
      if (beforePriority !== "1" && afterPriority === "1") {
        escalatedTasks += 1;
        escalatedTaskForJob = 1;
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
      `{"job":"${jobName}","quarantine_file":"${qfile}","duration_seconds":${durationSeconds},"duration_hours":${durationHours},"quarantine_count_24h":${qCount24h},"quarantine_count_7d":${qCount7d},"task_created":${createdTaskForJob},"task_escalated":${escalatedTaskForJob}}`
    );
  }

  if (totalQuarantined === 0) {
    insertEvent(dbName, env, source, "info", "No active quarantined cron jobs", "{\"total_quarantined\":0}");
  }

  const longestHours = Math.floor(longestDuration / 3600);
  if (totalQuarantined > 0) {
    console.log(
      `quarantine-tracker: total_quarantined=${totalQuarantined} longest_job=${longestJob} longest_duration_hours=${longestHours} new_tasks=${newTasks} escalated_tasks=${escalatedTasks}`
    );
  } else {
    console.log(
      "quarantine-tracker: total_quarantined=0 longest_duration_hours=0 new_tasks=0 escalated_tasks=0"
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
