#!/usr/bin/env npx tsx
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "../lib/db.js";
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

function runQuarantineTracker(scriptDir: string, env: NodeJS.ProcessEnv): void {
  const trackerScript = path.join(scriptDir, "quarantine-tracker.ts");
  if (!isExecutable(trackerScript)) return;
  spawnSync(trackerScript, {
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function queryLastSeenEpoch(dbName: string, whereClause: string, env: NodeJS.ProcessEnv): string {
  const sql = `
    SELECT COALESCE(EXTRACT(EPOCH FROM MAX(timestamp))::bigint, 0)
    FROM cortana_events
    WHERE (${whereClause});
  `;
  const res = runPsql(sql, {
    db: dbName,
    args: ["-q", "-X", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) return "0";
  return (res.stdout ?? "").toString().trim();
}

function queryLastSeenIso(dbName: string, whereClause: string, env: NodeJS.ProcessEnv): string {
  const sql = `
    SELECT COALESCE(to_char(MAX(timestamp) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'unknown')
    FROM cortana_events
    WHERE (${whereClause});
  `;
  const res = runPsql(sql, {
    db: dbName,
    args: ["-q", "-X", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) return "unknown";
  return (res.stdout ?? "").toString().trim();
}

function insertOverdueEvent(
  dbName: string,
  env: NodeJS.ProcessEnv,
  source: string,
  severity: string,
  monitor: string,
  lastSeen: string,
  ageSeconds: number,
  slaSeconds: number,
  slaHuman: string,
  consecutive: number
): void {
  const escMonitor = sqlEscape(monitor);
  const escLastSeen = sqlEscape(lastSeen);
  const escSlaHuman = sqlEscape(slaHuman);
  const message = `Meta-monitor overdue: ${monitor} (age=${ageSeconds}s, sla=${slaSeconds}s, consecutive=${consecutive})`;
  const escMessage = sqlEscape(message);

  const sql = `
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES (
      'meta_monitor_alert',
      '${source}',
      '${severity}',
      '${escMessage}',
      jsonb_build_object(
        'monitor', '${escMonitor}',
        'last_seen', '${escLastSeen}',
        'age_seconds', ${ageSeconds},
        'sla_seconds', ${slaSeconds},
        'sla', '${escSlaHuman}',
        'consecutive_overdue', ${consecutive}
      )
    );
  `;

  runPsql(sql, {
    db: dbName,
    args: ["-q", "-X", "-v", "ON_ERROR_STOP=1"],
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function insertHealthyEvent(
  dbName: string,
  env: NodeJS.ProcessEnv,
  source: string,
  healthyCsv: string,
  nowEpoch: number
): void {
  const escHealthy = sqlEscape(healthyCsv);
  const escMessage = sqlEscape("Meta-monitor healthy: all monitor SLAs satisfied");

  const sql = `
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES (
      'meta_monitor_alert',
      '${source}',
      'info',
      '${escMessage}',
      jsonb_build_object('monitors', '${escHealthy}', 'checked_at_epoch', ${nowEpoch})
    );
  `;

  runPsql(sql, {
    db: dbName,
    args: ["-q", "-X", "-v", "ON_ERROR_STOP=1"],
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

async function main(): Promise<number> {
  const env = { ...process.env, PATH: PATH_OVERRIDE };
  const psqlBin = process.env.PSQL_BIN ?? PSQL_BIN;
  const dbName = process.env.DB_NAME ?? "cortana";
  const source = "meta-monitor";

  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const stateDir = path.join(scriptDir, "state");
  const stateFile = path.join(stateDir, "meta-monitor-consecutive.state");
  fs.mkdirSync(stateDir, { recursive: true });

  if (!isExecutable(psqlBin)) {
    process.stderr.write(`psql not executable at ${psqlBin}\n`);
    return 1;
  }

  runQuarantineTracker(scriptDir, env);

  const monitors = [
    {
      name: "watchdog",
      where: "event_type ILIKE '%watchdog%'",
      slaSeconds: 1200,
      slaHuman: "15m",
    },
    {
      name: "proprioception",
      where: "event_type ILIKE '%proprioception%' OR event_type ILIKE '%health_check%'",
      slaSeconds: 9000,
      slaHuman: "2h",
    },
    {
      name: "cron_preflight",
      where: "event_type = 'cron_preflight'",
      slaSeconds: 93600,
      slaHuman: "24h",
    },
    {
      name: "subagent_watchdog",
      where: "event_type ILIKE '%subagent%watchdog%'",
      slaSeconds: 1800,
      slaHuman: "heartbeat",
    },
    {
      name: "heartbeat_state_validation",
      where: "event_type = 'heartbeat_state_snapshot'",
      slaSeconds: 23400,
      slaHuman: "6h",
    },
    {
      name: "browser_cdp_watchdog",
      where: "event_type='autonomy_action_result' AND source='autonomy-remediation' AND metadata->>'system'='browser'",
      slaSeconds: 7200,
      slaHuman: "2h",
    },
    {
      name: "vacation_mode_guard",
      where: "event_type='autonomy_action_result' AND source='autonomy-remediation' AND metadata->>'system'='vacation'",
      slaSeconds: 7200,
      slaHuman: "2h",
    },
  ];

  const stateMap = new Map<string, number>();
  const stateOrder: string[] = [];
  if (fs.existsSync(stateFile)) {
    const contents = fs.readFileSync(stateFile, "utf8");
    contents
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        const idx = line.indexOf("=");
        if (idx === -1) return;
        const key = line.slice(0, idx);
        const rawVal = line.slice(idx + 1);
        const num = /^[0-9]+$/.test(rawVal) ? Number(rawVal) : 0;
        if (!stateMap.has(key)) {
          stateOrder.push(key);
        }
        stateMap.set(key, num);
      });
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  let overdueCount = 0;

  const envWithPostgres = withPostgresPath(env);

  for (const monitor of monitors) {
    const lastSeenEpochRaw = queryLastSeenEpoch(dbName, monitor.where, envWithPostgres);
    const lastSeenEpoch = /^[0-9]+$/.test(lastSeenEpochRaw) ? Number(lastSeenEpochRaw) : 0;
    let ageSeconds = 999999999;
    let lastSeenIso = "unknown";
    if (lastSeenEpoch > 0) {
      ageSeconds = nowEpoch - lastSeenEpoch;
      lastSeenIso = queryLastSeenIso(dbName, monitor.where, envWithPostgres);
    }

    if (ageSeconds > monitor.slaSeconds) {
      const prev = stateMap.get(monitor.name) ?? 0;
      const curr = prev + 1;
      if (!stateMap.has(monitor.name)) {
        stateOrder.push(monitor.name);
      }
      stateMap.set(monitor.name, curr);
      overdueCount += 1;

      let severity = "warning";
      if (curr >= 2) severity = "critical";

      insertOverdueEvent(
        dbName,
        envWithPostgres,
        source,
        severity,
        monitor.name,
        lastSeenIso,
        ageSeconds,
        monitor.slaSeconds,
        monitor.slaHuman,
        curr
      );
    } else {
      if (!stateMap.has(monitor.name)) {
        stateOrder.push(monitor.name);
      }
      stateMap.set(monitor.name, 0);
    }
  }

  if (overdueCount === 0) {
    const healthyList = monitors.map((m) => m.name).join(",");
    insertHealthyEvent(dbName, envWithPostgres, source, healthyList, nowEpoch);
  }

  const stateLines = stateOrder.map((key) => `${key}=${stateMap.get(key) ?? 0}`);
  fs.writeFileSync(stateFile, stateLines.join("\n") + (stateLines.length ? "\n" : ""));

  console.log(`meta-monitor complete: overdue=${overdueCount}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
