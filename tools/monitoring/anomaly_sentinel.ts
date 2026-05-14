#!/usr/bin/env npx tsx

import { query } from "../lib/db.js";

type Json = Record<string, any>;

type Anomaly = {
  anomaly_class: string;
  severity: string;
  title: string;
  message: string;
  fingerprint: string;
  metric_name: string;
  latest_value: number;
  baseline_mean: number;
  baseline_stddev: number;
  z_score: number;
  threshold: number;
  details: Record<string, any>;
};

const DB_NAME = process.env.CORTANA_DB ?? "cortana";
const SOURCE = "anomaly_sentinel";

function sqlEscape(text: string): string {
  return (text || "").replace(/'/g, "''");
}

function runPsql(sql: string): string {
  return query(sql).trim();
}

function fetchJson(sql: string): any {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}) t;`;
  const raw = runPsql(wrapped);
  return raw ? JSON.parse(raw) : [];
}

function meanStddev(values: number[]): [number, number] {
  if (!values.length) return [0, 0];
  if (values.length === 1) return [values[0], 0];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return [mean, Math.sqrt(variance)];
}

function spikeTest(
  metricName: string,
  latestValue: number,
  baseline: number[],
  opts: { hardThreshold: number; zThreshold?: number; ratioThreshold?: number }
): [boolean, number, number, number] {
  const [baselineMean, baselineStd] = meanStddev(baseline);
  let z = 0;
  if (baselineStd > 0) z = (latestValue - baselineMean) / baselineStd;
  const ratioThreshold = opts.ratioThreshold ?? 1.6;
  const zThreshold = opts.zThreshold ?? 2.0;
  const ratioOk = latestValue >= (baselineMean > 0 ? baselineMean * ratioThreshold : opts.hardThreshold);
  const hardOk = latestValue >= opts.hardThreshold;
  const zOk = z >= zThreshold;
  const triggered = hardOk && (zOk || ratioOk);
  return [triggered, baselineMean, baselineStd, z];
}

function isSuppressed(fingerprint: string, suppressionHours: number): boolean {
  const sql =
    "SELECT COUNT(*) FROM cortana_events " +
    "WHERE event_type='anomaly_detected' " +
    `AND metadata->>'fingerprint'='${sqlEscape(fingerprint)}' ` +
    `AND timestamp >= NOW() - INTERVAL '${Math.trunc(suppressionHours)} hours';`;
  const raw = runPsql(sql);
  return Number(raw || "0") > 0;
}

function anomalyMetadata(anomaly: Anomaly): Record<string, any> {
  return {
    anomaly_class: anomaly.anomaly_class,
    fingerprint: anomaly.fingerprint,
    metric: {
      name: anomaly.metric_name,
      latest: Math.round(anomaly.latest_value * 10000) / 10000,
      baseline_mean: Math.round(anomaly.baseline_mean * 10000) / 10000,
      baseline_stddev: Math.round(anomaly.baseline_stddev * 10000) / 10000,
      z_score: Math.round(anomaly.z_score * 10000) / 10000,
      threshold: anomaly.threshold,
    },
    details: anomaly.details,
    detected_at: new Date().toISOString(),
  };
}

function writeAnomalyEvent(anomaly: Anomaly): void {
  const metadata = JSON.stringify(anomalyMetadata(anomaly));
  const sql =
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES " +
    `('anomaly_detected','${SOURCE}','${sqlEscape(anomaly.severity)}','${sqlEscape(
      anomaly.message
    )}','${sqlEscape(metadata)}'::jsonb);`;
  runPsql(sql);
}

function detectTimeoutRate(days: number): Anomaly[] {
  const rows = fetchJson(
    `
        SELECT day,
               SUM(timeout_count)::int AS timeout_count,
               SUM(total_count)::int AS total_count,
               ROUND((SUM(timeout_count)::numeric / NULLIF(SUM(total_count), 0)), 4) AS timeout_rate
        FROM (
          SELECT date_trunc('day', created_at)::date AS day,
                 CASE WHEN event_type='agent_timeout' THEN 1 ELSE 0 END AS timeout_count,
                 CASE WHEN event_type IN ('agent_completed','agent_failed','agent_timeout') THEN 1 ELSE 0 END AS total_count
          FROM cortana_event_bus_events
          WHERE created_at >= NOW() - INTERVAL '${days} days'
            AND event_type IN ('agent_completed','agent_failed','agent_timeout')
        ) s
        GROUP BY day
        HAVING SUM(total_count) >= 5
        ORDER BY day
        `
  );
  if (!Array.isArray(rows) || rows.length < 3) return [];

  const series = rows.map((r: any) => Number(r.timeout_rate ?? 0));
  const latest = series[series.length - 1];
  const baseline = series.slice(0, -1);
  const [triggered, mu, sigma, z] = spikeTest("subagent_timeout_rate_per_day", latest, baseline, {
    hardThreshold: 0.15,
    zThreshold: 2.2,
    ratioThreshold: 1.8,
  });
  if (!triggered) return [];

  const recentSources = fetchJson(
    `
        SELECT COALESCE(source, 'unknown') AS source,
               COUNT(*)::int AS timeout_events
        FROM cortana_event_bus_events
        WHERE created_at >= NOW() - INTERVAL '72 hours'
          AND event_type='agent_timeout'
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT 8
        `
  );

  const latestRow = rows[rows.length - 1] ?? {};
  const a: Anomaly = {
    anomaly_class: "subagent_timeout_rate_rising",
    severity: latest < 0.3 ? "warning" : "error",
    title: "Rising timeout rate in subagent runs",
    message: `Subagent timeout rate is ${(latest * 100).toFixed(1)}% today (${Math.trunc(
      latestRow.timeout_count ?? 0
    )}/${Math.trunc(latestRow.total_count ?? 0)}) vs baseline ${(mu * 100).toFixed(1)}%.`,
    fingerprint: "subagent_timeout_rate_rising:global",
    metric_name: "subagent_timeout_rate_per_day",
    latest_value: latest,
    baseline_mean: mu,
    baseline_stddev: sigma,
    z_score: z,
    threshold: 0.15,
    details: { days, series: rows, timeout_sources_72h: recentSources },
  };

  return [a];
}

function detectCronFailureClusters(days: number): Anomaly[] {
  const rows = fetchJson(
    `
        WITH by_day AS (
          SELECT date_trunc('day', timestamp)::date AS day,
                 cron_name,
                 COUNT(*) FILTER (WHERE status IN ('failed','failing','missed'))::int AS fail_count,
                 MAX(COALESCE(consecutive_failures,0))::int AS max_consecutive
          FROM cortana_cron_health
          WHERE timestamp >= NOW() - INTERVAL '${days} days'
          GROUP BY 1,2
        )
        SELECT day,
               COUNT(*) FILTER (WHERE fail_count >= 3 OR max_consecutive >= 3)::int AS clustered_crons
        FROM by_day
        GROUP BY day
        ORDER BY day
        `
  );
  if (!Array.isArray(rows) || rows.length < 3) return [];

  const series = rows.map((r: any) => Number(r.clustered_crons ?? 0));
  const latest = series[series.length - 1];
  const baseline = series.slice(0, -1);
  const [triggered, mu, sigma, z] = spikeTest("cron_failure_clusters_per_day", latest, baseline, {
    hardThreshold: 1.0,
    zThreshold: 1.8,
    ratioThreshold: 1.6,
  });
  if (!triggered) return [];

  const offenders = fetchJson(
    `
        SELECT cron_name,
               COUNT(*) FILTER (WHERE status IN ('failed','failing','missed'))::int AS fail_count_72h,
               MAX(COALESCE(consecutive_failures,0))::int AS max_consecutive,
               MAX(timestamp) AS last_seen
        FROM cortana_cron_health
        WHERE timestamp >= NOW() - INTERVAL '72 hours'
        GROUP BY cron_name
        HAVING COUNT(*) FILTER (WHERE status IN ('failed','failing','missed')) >= 2
        ORDER BY max_consecutive DESC, fail_count_72h DESC
        LIMIT 10
        `
  );

  const a: Anomaly = {
    anomaly_class: "cron_failure_cluster",
    severity: latest < 3 ? "warning" : "error",
    title: "Cron failure clusters",
    message: `${Math.trunc(latest)} cron(s) entered repeated-failure cluster state today (baseline ${mu.toFixed(2)}).`,
    fingerprint: "cron_failure_cluster:global",
    metric_name: "cron_failure_clusters_per_day",
    latest_value: latest,
    baseline_mean: mu,
    baseline_stddev: sigma,
    z_score: z,
    threshold: 1.0,
    details: { days, series: rows, offenders_72h: offenders },
  };

  return [a];
}

function detectTokenBurnSpike(days: number): Anomaly[] {
  const rows = fetchJson(
    `
        SELECT date_trunc('day', timestamp)::date AS day,
               SUM(tokens_in + tokens_out)::bigint AS total_tokens,
               SUM(estimated_cost)::numeric(12,6) AS estimated_cost
        FROM cortana_token_ledger
        WHERE timestamp >= NOW() - INTERVAL '${days} days'
        GROUP BY 1
        ORDER BY 1
        `
  );
  if (!Array.isArray(rows) || rows.length < 3) return [];

  const series = rows.map((r: any) => Number(r.total_tokens ?? 0));
  const latest = series[series.length - 1];
  const baseline = series.slice(0, -1);
  const [triggered, mu, sigma, z] = spikeTest("token_burn_per_day", latest, baseline, {
    hardThreshold: 120000,
    zThreshold: 2.0,
    ratioThreshold: 1.7,
  });
  if (!triggered) return [];

  const modelBreakdown = fetchJson(
    `
        SELECT model,
               SUM(tokens_in + tokens_out)::bigint AS total_tokens,
               SUM(estimated_cost)::numeric(12,6) AS estimated_cost
        FROM cortana_token_ledger
        WHERE timestamp >= NOW() - INTERVAL '24 hours'
        GROUP BY model
        ORDER BY total_tokens DESC
        LIMIT 8
        `
  );

  const a: Anomaly = {
    anomaly_class: "token_burn_spike",
    severity: latest < 250000 ? "warning" : "error",
    title: "Sudden token burn spike",
    message: `Token burn rose to ${Math.trunc(latest).toLocaleString()} tokens today (baseline ${
      Math.trunc(mu).toLocaleString()
    }).`,
    fingerprint: "token_burn_spike:global",
    metric_name: "token_burn_per_day",
    latest_value: latest,
    baseline_mean: mu,
    baseline_stddev: sigma,
    z_score: z,
    threshold: 120000,
    details: { days, series: rows, model_breakdown_24h: modelBreakdown },
  };

  return [a];
}

function runScan(days: number, suppressionHours: number, dryRun = false): Json {
  const anomalies: Anomaly[] = [];
  const detectorErrors: string[] = [];

  for (const detector of [detectTimeoutRate, detectCronFailureClusters, detectTokenBurnSpike]) {
    try {
      anomalies.push(...detector(days));
    } catch (e) {
      detectorErrors.push(`${detector.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const emitted: Json[] = [];
  const suppressed: Json[] = [];

  for (const anomaly of anomalies) {
    const row = {
      anomaly_class: anomaly.anomaly_class,
      severity: anomaly.severity,
      title: anomaly.title,
      message: anomaly.message,
      fingerprint: anomaly.fingerprint,
      metric_name: anomaly.metric_name,
      latest_value: anomaly.latest_value,
      z_score: anomaly.z_score,
    };

    if (isSuppressed(anomaly.fingerprint, suppressionHours)) {
      suppressed.push(row);
      continue;
    }

    emitted.push(row);
    if (!dryRun) writeAnomalyEvent(anomaly);
  }

  return {
    source: SOURCE,
    scanned_at: new Date().toISOString(),
    days,
    suppression_hours: suppressionHours,
    detected_count: anomalies.length,
    emitted_count: emitted.length,
    suppressed_count: suppressed.length,
    emitted,
    suppressed,
    errors: detectorErrors,
  };
}

function report(days: number, weekly: boolean): Json {
  const sinceInterval = weekly ? "7 days" : `${days} days`;
  const rows = fetchJson(
    `
        SELECT
          metadata->>'anomaly_class' AS anomaly_class,
          COALESCE(metadata->>'fingerprint','unknown') AS fingerprint,
          COUNT(*)::int AS hits,
          MAX(timestamp) AS last_seen,
          MAX(severity) AS max_severity,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT message ORDER BY message), NULL) AS sample_messages
        FROM cortana_events
        WHERE event_type='anomaly_detected'
          AND timestamp >= NOW() - INTERVAL '${sinceInterval}'
        GROUP BY 1,2
        ORDER BY hits DESC, last_seen DESC
        `
  );

  const totalEvents = Array.isArray(rows)
    ? rows.reduce((sum: number, r: any) => sum + Number(r.hits ?? 0), 0)
    : 0;

  return {
    source: SOURCE,
    mode: weekly ? "weekly_summary" : "report",
    window: sinceInterval,
    generated_at: new Date().toISOString(),
    anomalies: rows,
    total_anomaly_fingerprints: Array.isArray(rows) ? rows.length : 0,
    total_events: Math.trunc(totalEvents),
  };
}

function alert(days: number, suppressionHours: number): Json {
  const scan = runScan(days, suppressionHours, false);
  if (scan.emitted_count === 0) {
    return {
      source: SOURCE,
      alert: "none",
      message: "No meaningful anomalies detected.",
      scan,
    };
  }
  return {
    source: SOURCE,
    alert: "triggered",
    message: `${scan.emitted_count} anomaly alert(s) emitted.`,
    scan,
  };
}

function usage(): string {
  return (
    "Usage: anomaly_sentinel.ts <scan|report|alert> [options]\n" +
    "scan: --days 7|14|30 [--suppression-hours N] [--dry-run]\n" +
    "report: [--days N] [--weekly]\n" +
    "alert: --days 7|14|30 [--suppression-hours N]"
  );
}

function parseCommand(argv: string[]): { command: string; options: Record<string, string | boolean> } {
  if (!argv.length) {
    throw new Error("missing command");
  }
  const command = argv[0];
  const options: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.replace(/^--/, "");
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
      }
    }
  }
  return { command, options };
}

async function main(): Promise<void> {
  let command = "";
  let options: Record<string, string | boolean> = {};
  try {
    const parsed = parseCommand(process.argv.slice(2));
    command = parsed.command;
    options = parsed.options;
  } catch {
    console.error(usage());
    process.exit(2);
  }

  let output: Json;
  if (command === "scan") {
    const days = Number(options.days ?? 7);
    const suppression = Number(options["suppression-hours"] ?? 12);
    const dryRun = Boolean(options["dry-run"] ?? false);
    if (![7, 14, 30].includes(days)) throw new Error("invalid --days (expected 7, 14, 30)");
    output = runScan(days, suppression, dryRun);
  } else if (command === "report") {
    const days = Number(options.days ?? 14);
    const weekly = Boolean(options.weekly ?? false);
    output = report(days, weekly);
  } else if (command === "alert") {
    const days = Number(options.days ?? 7);
    const suppression = Number(options["suppression-hours"] ?? 12);
    if (![7, 14, 30].includes(days)) throw new Error("invalid --days (expected 7, 14, 30)");
    output = alert(days, suppression);
  } else {
    throw new Error("unknown command");
  }

  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
