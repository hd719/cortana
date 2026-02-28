#!/usr/bin/env npx tsx
import fs from "fs";
import os from "os";
import path from "path";
import { runPsql, withPostgresPath } from "../lib/db.js";
import { PSQL_BIN } from "../lib/paths.js";

function usage(): void {
  process.stdout.write(`Usage: meta-monitor.sh [--json | --brief]

Monitors monitor health from PostgreSQL:
- cortana_cron_health: flags crons with >=2 consecutive failures
- cortana_tool_health: flags tools down continuously for >1h
- Meta-monitor staleness: checks last run timestamp in local state file

Flags:
  --json   Machine-readable JSON output
  --brief  One-line summary
  -h, --help  Show this help

Environment overrides:
  PSQL_BIN, DB_NAME, LAST_N, DOWN_THRESHOLD_SECONDS, META_STALE_SECONDS
`);
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseIsoToEpoch(ts: string): number {
  const trimmed = ts.trim();
  if (!trimmed) return 0;
  let normalized = trimmed.replace("Z", "+00:00");
  if (!normalized.includes("T") && normalized.includes(" ")) {
    normalized = normalized.replace(" ", "T");
  }
  const dt = new Date(normalized);
  if (Number.isNaN(dt.getTime())) return 0;
  return Math.floor(dt.getTime() / 1000);
}

function isoFromEpoch(epoch: number | null): string | null {
  if (!epoch) return null;
  const dt = new Date(epoch * 1000);
  return dt.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const sign = scaled < 0 ? -1 : 1;
  const abs = Math.abs(scaled);
  const floor = Math.floor(abs);
  const diff = abs - floor;
  let rounded = floor;
  if (diff > 0.5) {
    rounded = floor + 1;
  } else if (diff === 0.5) {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  }
  return (rounded * sign) / factor;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let mode: "full" | "json" | "brief" = "full";

  while (argv.length > 0) {
    const arg = argv.shift();
    if (!arg) continue;
    if (arg === "--json") {
      if (mode !== "full") {
        process.stderr.write("Only one mode flag may be used\n");
        return 2;
      }
      mode = "json";
      continue;
    }
    if (arg === "--brief") {
      if (mode !== "full") {
        process.stderr.write("Only one mode flag may be used\n");
        return 2;
      }
      mode = "brief";
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      return 0;
    }
    process.stderr.write(`Unknown flag: ${arg}\n`);
    usage();
    return 2;
  }

  const psqlBin = process.env.PSQL_BIN ?? PSQL_BIN;
  const dbName = process.env.DB_NAME ?? "cortana";
  const lastN = Number(process.env.LAST_N ?? "10");
  const downThresholdSeconds = Number(process.env.DOWN_THRESHOLD_SECONDS ?? "3600");
  const metaStaleSeconds = Number(process.env.META_STALE_SECONDS ?? "28800");

  if (!isExecutable(psqlBin)) {
    process.stderr.write(`ERROR: psql binary not executable at ${psqlBin}\n`);
    return 1;
  }

  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const stateDir = path.join(scriptDir, "state");
  const stateFile = path.join(stateDir, "last_run_epoch");
  fs.mkdirSync(stateDir, { recursive: true });

  const env = withPostgresPath(process.env);

  const cronSql = `
SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.cron_name, t.timestamp DESC)::text, '[]')
FROM (
  SELECT
    cron_name,
    timestamp,
    status,
    consecutive_failures,
    COALESCE(metadata->>'last_error', metadata->>'error', metadata->>'reason', '') AS last_error
  FROM cortana_cron_health
  WHERE timestamp >= NOW() - INTERVAL '14 days'
) t;
`;

  const toolSql = `
SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.tool_name, t.timestamp DESC)::text, '[]')
FROM (
  SELECT
    tool_name,
    timestamp,
    status,
    COALESCE(error, '') AS error
  FROM cortana_tool_health
  WHERE timestamp >= NOW() - INTERVAL '14 days'
) t;
`;

  const cronRes = runPsql(cronSql, {
    db: dbName,
    args: ["-q", "-X", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (cronRes.status !== 0) {
    return 1;
  }
  const toolRes = runPsql(toolSql, {
    db: dbName,
    args: ["-q", "-X", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (toolRes.status !== 0) {
    return 1;
  }

  const cronDataRaw = (cronRes.stdout ?? "[]").toString();
  const toolDataRaw = (toolRes.stdout ?? "[]").toString();

  let cronRows: Array<Record<string, any>> = [];
  let toolRows: Array<Record<string, any>> = [];
  try {
    cronRows = JSON.parse(cronDataRaw.trim() || "[]");
  } catch {
    cronRows = [];
  }
  try {
    toolRows = JSON.parse(toolDataRaw.trim() || "[]");
  } catch {
    toolRows = [];
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  const prevRunRaw = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8").trim() : "";

  const BAD = new Set(["failed", "fail", "missed", "down", "error", "degraded", "critical"]);
  const GOOD = new Set(["ok", "healthy", "up", "nominal"]);

  const byCron = new Map<string, Array<Record<string, any>>>();
  for (const row of cronRows) {
    const name = row?.cron_name || "unknown";
    if (!byCron.has(name)) byCron.set(name, []);
    byCron.get(name)?.push(row);
  }

  const cronAlerts: Array<Record<string, any>> = [];
  for (const [cronName, rows] of byCron.entries()) {
    const sorted = rows.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    const recent = sorted.slice(0, lastN);
    if (recent.length === 0) continue;

    let failCount = 0;
    let lastError = "";
    for (const row of recent) {
      const status = String(row.status ?? "").trim().toLowerCase();
      if (GOOD.has(status)) break;
      failCount += 1;
      if (!lastError) {
        lastError = String(row.last_error ?? "").trim();
      }
    }

    if (failCount >= 2) {
      let lastSuccessEpoch: number | null = null;
      for (const row of sorted) {
        const status = String(row.status ?? "").trim().toLowerCase();
        if (GOOD.has(status)) {
          lastSuccessEpoch = parseIsoToEpoch(String(row.timestamp));
          break;
        }
      }

      cronAlerts.push({
        cron_name: cronName,
        consecutive_failures: failCount,
        last_error: lastError || "(no error message)",
        last_success_at: isoFromEpoch(lastSuccessEpoch),
        last_seen_at: recent[0]?.timestamp,
      });
    }
  }

  cronAlerts.sort((a, b) => {
    const diff = (b.consecutive_failures ?? 0) - (a.consecutive_failures ?? 0);
    if (diff !== 0) return diff;
    return String(a.cron_name).localeCompare(String(b.cron_name));
  });

  const byTool = new Map<string, Array<Record<string, any>>>();
  for (const row of toolRows) {
    const name = row?.tool_name || "unknown";
    if (!byTool.has(name)) byTool.set(name, []);
    byTool.get(name)?.push(row);
  }

  const toolAlerts: Array<Record<string, any>> = [];
  for (const [toolName, rows] of byTool.entries()) {
    const sorted = rows.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    if (sorted.length === 0) continue;

    const latest = sorted[0];
    const latestStatus = String(latest.status ?? "").trim().toLowerCase();
    if (GOOD.has(latestStatus)) continue;

    let downStartEpoch = parseIsoToEpoch(String(latest.timestamp));
    let latestError = String(latest.error ?? "").trim();

    for (const row of sorted.slice(1)) {
      const status = String(row.status ?? "").trim().toLowerCase();
      const tsEpoch = parseIsoToEpoch(String(row.timestamp));
      if (GOOD.has(status)) break;
      downStartEpoch = tsEpoch;
      if (!latestError) {
        latestError = String(row.error ?? "").trim();
      }
    }

    const downFor = nowEpoch - downStartEpoch;
    if (downFor > downThresholdSeconds) {
      toolAlerts.push({
        tool_name: toolName,
        status: latest.status,
        down_since: isoFromEpoch(downStartEpoch),
        down_for_seconds: downFor,
        last_error: latestError || "(no error message)",
        last_seen_at: latest.timestamp,
      });
    }
  }

  toolAlerts.sort((a, b) => {
    const diff = (b.down_for_seconds ?? 0) - (a.down_for_seconds ?? 0);
    if (diff !== 0) return diff;
    return String(a.tool_name).localeCompare(String(b.tool_name));
  });

  const prevRunEpoch = /^[0-9]+$/.test(prevRunRaw) ? Number(prevRunRaw) : null;
  const meta = {
    last_run_at: isoFromEpoch(prevRunEpoch),
    last_run_epoch: prevRunEpoch,
    now_at: isoFromEpoch(nowEpoch),
    now_epoch: nowEpoch,
    stale_after_seconds: metaStaleSeconds,
    is_stale: false,
    seconds_since_last_run: null as number | null,
  };

  if (prevRunEpoch) {
    const delta = nowEpoch - prevRunEpoch;
    meta.seconds_since_last_run = delta;
    meta.is_stale = delta > metaStaleSeconds;
  }

  let overall: "ok" | "warn" | "critical" = "ok";
  if (meta.is_stale || cronAlerts.length > 0 || toolAlerts.length > 0) {
    overall = "warn";
  }
  if (meta.is_stale && (cronAlerts.length > 0 || toolAlerts.length > 0)) {
    overall = "critical";
  }

  const icon = overall === "ok" ? "✅" : overall === "warn" ? "⚠️" : "❌";
  const payload = {
    generated_at: isoFromEpoch(nowEpoch),
    overall,
    status_icon: icon,
    thresholds: {
      cron_last_n: lastN,
      tool_down_seconds: downThresholdSeconds,
      meta_stale_seconds: metaStaleSeconds,
    },
    cron: {
      tracked: byCron.size,
      alerts: cronAlerts,
    },
    tools: {
      tracked: byTool.size,
      alerts: toolAlerts,
    },
    meta_monitor: meta,
  };

  if (mode === "json") {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (mode === "brief") {
    process.stdout.write(
      `${icon} overall=${overall} cron_alerts=${cronAlerts.length} tool_alerts=${toolAlerts.length} meta_stale=${
        meta.is_stale ? "yes" : "no"
      }\n`
    );
  } else {
    process.stdout.write(`${icon} Meta Monitor\n`);
    process.stdout.write(`Generated: ${payload.generated_at}\n`);
    process.stdout.write("\n");
    process.stdout.write(
      `${cronAlerts.length === 0 ? "✅" : "⚠️"} Cron health: ${cronAlerts.length} alert(s) from ${byCron.size} tracked\n`
    );
    for (const alert of cronAlerts) {
      process.stdout.write(
        `  - ${alert.cron_name}: ${alert.consecutive_failures} consecutive failures; last error: ${alert.last_error}; last success: ${
          alert.last_success_at || "never/unknown"
        }\n`
      );
    }

    process.stdout.write("\n");
    process.stdout.write(
      `${toolAlerts.length === 0 ? "✅" : "⚠️"} Tool health: ${toolAlerts.length} alert(s) from ${byTool.size} tracked\n`
    );
    for (const alert of toolAlerts) {
      const mins = roundTo(alert.down_for_seconds / 60, 1);
      process.stdout.write(
        `  - ${alert.tool_name}: status=${alert.status}, down_for=${mins}m, down_since=${alert.down_since}, last_error=${alert.last_error}\n`
      );
    }

    process.stdout.write("\n");
    const mmIcon = meta.is_stale ? "⚠️" : "✅";
    const age = meta.seconds_since_last_run;
    const ageStr = age != null ? `${roundTo(age / 3600, 2)}h` : "first run";
    process.stdout.write(
      `${mmIcon} Meta-monitor recency: ${ageStr} since previous run (stale>${roundTo(
        metaStaleSeconds / 3600,
        2
      )}h)\n`
    );
  }

  fs.writeFileSync(stateFile, `${nowEpoch}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
