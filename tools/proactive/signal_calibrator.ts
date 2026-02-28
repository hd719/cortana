#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { query } from "../lib/db.js";
import { resolveRepoPath } from "../lib/paths.js";

type AnyObj = Record<string, any>;

type AlertRecord = {
  alert_id: number;
  timestamp: string;
  category: string;
  source: string;
  event_type: string;
  message: string;
  metadata: AnyObj;
  noise_flagged: boolean;
  led_to_action: boolean;
  task_id: number | null;
  task_status: string | null;
  user_response_within_30m: boolean;
};

const WORKSPACE = resolveRepoPath();
const THRESHOLD_PATH = path.join(WORKSPACE, "config", "alert-thresholds.json");
const LATEST_AUDIT_PATH = path.join(WORKSPACE, "reports", "proactive-signal-audit.json");
const VALID_CATEGORIES = ["portfolio", "email", "calendar", "weather", "health", "tech_news"];
const NOISE_TOKENS = ["noise", "noisy", "too many alerts", "spam", "alert fatigue", "irrelevant"];
const ACTION_TASK_STATUSES = new Set(["completed", "in_progress"]);

function runPsql(sql: string): string {
  return query(sql).trim();
}

function fetchJson(sql: string): AnyObj[] {
  const wrapped = `SELECT COALESCE(json_agg(t),'[]'::json)::text FROM (${sql}) t;`;
  const raw = runPsql(wrapped);
  return raw ? (JSON.parse(raw) as AnyObj[]) : [];
}

function exists(table: string): boolean {
  const safe = table.replace(/'/g, "''");
  return (runPsql(`SELECT to_regclass('${safe}') IS NOT NULL;`) || "").trim().toLowerCase() === "t";
}

function hasCol(table: string, col: string): boolean {
  const t = table.replace(/'/g, "''");
  const c = col.replace(/'/g, "''");
  const q =
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns " +
    `WHERE table_schema='public' AND table_name='${t}' AND column_name='${c}');`;
  return (runPsql(q) || "").trim().toLowerCase() === "t";
}

function parseTs(ts?: string | null): Date | null {
  if (!ts) return null;
  const d = new Date(ts.replace("Z", "+00:00"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function detectCategory(signalType: string, eventType: string, source: string, message: string, metadata: AnyObj): string {
  const mdText = JSON.stringify(metadata || {}).toLowerCase();
  const haystack = [signalType || "", eventType || "", source || "", message || "", mdText].join(" ").toLowerCase();

  const checks: Record<string, string[]> = {
    portfolio: ["portfolio", "watchlist", "position", "trade", "canslim", "market"],
    email: ["email", "gmail", "inbox", "mail"],
    calendar: ["calendar", "meeting", "event", "khal", "caldav"],
    weather: ["weather", "forecast", "rain", "temperature"],
    health: ["health", "whoop", "tonal", "fitness", "recovery", "sleep", "strain"],
    tech_news: ["tech_news", "tech news", "newsletter", "hacker news", "github"],
  };

  for (const [cat, tokens] of Object.entries(checks)) {
    if (tokens.some((tok) => haystack.includes(tok))) return cat;
  }
  return "tech_news";
}

function loadAlerts(days: number): AlertRecord[] {
  const rows: AnyObj[] = [];

  if (exists("cortana_proactive_signals")) {
    const q = `
      SELECT
        id::bigint AS alert_id,
        created_at,
        COALESCE(signal_type,'') AS signal_type,
        COALESCE(source,'') AS source,
        COALESCE(title,'') AS message,
        COALESCE(metadata,'{}'::jsonb) AS metadata,
        'proactive_signal'::text AS event_type
      FROM cortana_proactive_signals
      WHERE created_at >= NOW() - INTERVAL '${Math.trunc(days)} days'
    `;
    rows.push(...fetchJson(q));
  }

  if (exists("cortana_events")) {
    const q = `
      SELECT
        id::bigint AS alert_id,
        timestamp AS created_at,
        COALESCE(metadata->>'signal_type', metadata->>'category', event_type, '') AS signal_type,
        COALESCE(source,'') AS source,
        COALESCE(message,'') AS message,
        COALESCE(metadata,'{}'::jsonb) AS metadata,
        COALESCE(event_type,'') AS event_type
      FROM cortana_events
      WHERE timestamp >= NOW() - INTERVAL '${Math.trunc(days)} days'
        AND (
          event_type ILIKE 'proactive%'
          OR source ILIKE 'proactive%'
          OR metadata::text ILIKE '%heartbeat%'
          OR metadata::text ILIKE '%watchlist%'
          OR metadata::text ILIKE '%portfolio%'
          OR message ILIKE '%alert%'
        )
    `;
    rows.push(...fetchJson(q));
  }

  const dedup = new Map<string, AlertRecord>();
  for (const r of rows) {
    const created = String(r.created_at || "");
    const source = String(r.source || "");
    const eventType = String(r.event_type || "");
    const message = String(r.message || "");
    const metadata = typeof r.metadata === "object" && r.metadata ? r.metadata : {};
    const signalType = String(r.signal_type || "");
    const category = detectCategory(signalType, eventType, source, message, metadata);
    const aid = Number(r.alert_id || 0);
    const key = `${created}|${category}|${message.slice(0, 80)}`;
    if (dedup.has(key)) continue;

    dedup.set(key, {
      alert_id: aid,
      timestamp: created,
      category,
      source,
      event_type: eventType,
      message,
      metadata,
      noise_flagged: false,
      led_to_action: false,
      task_id: null,
      task_status: null,
      user_response_within_30m: false,
    });
  }

  return [...dedup.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function findNoiseFeedback(days: number): AnyObj[] {
  if (!exists("cortana_feedback")) return [];
  const whereNoise = NOISE_TOKENS.map((tok) => `context ILIKE '%${tok}%' OR lesson ILIKE '%${tok}%'`).join(" OR ");
  const q = `
    SELECT id, timestamp, feedback_type, context, lesson
    FROM cortana_feedback
    WHERE timestamp >= NOW() - INTERVAL '${Math.trunc(days)} days'
      AND (${whereNoise})
    ORDER BY timestamp ASC
  `;
  return fetchJson(q);
}

function markNoiseFlags(alerts: AlertRecord[], feedbackRows: AnyObj[]): void {
  for (const fb of feedbackRows) {
    const context = `${fb.context || ""} ${fb.lesson || ""}`.toLowerCase();
    for (const a of alerts) {
      if (context.includes(a.category)) a.noise_flagged = true;
    }
  }
}

function loadTasks(days: number): AnyObj[] {
  if (!exists("cortana_tasks")) return [];

  const whereParts = [`created_at >= NOW() - INTERVAL '${Math.trunc(days)} days'`];
  if (hasCol("cortana_tasks", "source")) {
    whereParts.push("(source ILIKE '%proactive%' OR source ILIKE '%heartbeat%' OR source ILIKE '%watchlist%')");
  }

  const q = `
    SELECT id, created_at, status, source, title, description, metadata
    FROM cortana_tasks
    WHERE ${whereParts.join(" AND ")}
    ORDER BY created_at ASC
  `;
  return fetchJson(q);
}

function loadUserResponseEvents(days: number): AnyObj[] {
  if (!exists("cortana_events")) return [];
  const q = `
    SELECT id, timestamp, source, event_type, message, metadata
    FROM cortana_events
    WHERE timestamp >= NOW() - INTERVAL '${Math.trunc(days)} days'
      AND (
        event_type ILIKE '%message%'
        OR event_type ILIKE '%reply%'
        OR source ILIKE '%telegram%'
        OR source ILIKE '%chat%'
        OR message ILIKE '%task done%'
      )
    ORDER BY timestamp ASC
  `;
  return fetchJson(q);
}

function correlateActions(alerts: AlertRecord[], tasks: AnyObj[], userEvents: AnyObj[]): void {
  for (const alert of alerts) {
    const ats = parseTs(alert.timestamp);
    if (!ats) continue;

    for (const t of tasks) {
      const tts = parseTs(String(t.created_at || ""));
      if (!tts) continue;
      const dt = (tts.getTime() - ats.getTime()) / 1000;
      if (dt < 0 || dt > 1800) continue;

      const searchable = [
        String(t.title || "").toLowerCase(),
        String(t.description || "").toLowerCase(),
        JSON.stringify((typeof t.metadata === "object" && t.metadata) || {}).toLowerCase(),
      ].join(" ");

      if (searchable.includes(alert.category) || searchable.includes("proactive") || searchable.includes("alert")) {
        alert.task_id = Number(t.id || 0);
        alert.task_status = String(t.status || "");
        if (ACTION_TASK_STATUSES.has(alert.task_status.toLowerCase())) alert.led_to_action = true;
        break;
      }
    }

    for (const ue of userEvents) {
      const uts = parseTs(String(ue.timestamp || ""));
      if (!uts) continue;
      const dt = (uts.getTime() - ats.getTime()) / 1000;
      if (dt < 0 || dt > 1800) continue;

      const payload = [
        String(ue.event_type || "").toLowerCase(),
        String(ue.source || "").toLowerCase(),
        String(ue.message || "").toLowerCase(),
        JSON.stringify((typeof ue.metadata === "object" && ue.metadata) || {}).toLowerCase(),
      ].join(" ");

      if (["telegram", "reply", "message", "task done", "mark task"].some((k) => payload.includes(k))) {
        alert.user_response_within_30m = true;
        alert.led_to_action = true;
        break;
      }
    }
  }
}

function loadThresholds(): Record<string, number> {
  if (!fs.existsSync(THRESHOLD_PATH)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(THRESHOLD_PATH, "utf8")) as AnyObj;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(data)) {
      const n = Number(v);
      if (!Number.isNaN(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function saveThresholds(data: Record<string, number>): void {
  fs.mkdirSync(path.dirname(THRESHOLD_PATH), { recursive: true });
  const ordered: Record<string, number> = {};
  for (const k of VALID_CATEGORIES) if (k in data) ordered[k] = data[k];
  fs.writeFileSync(THRESHOLD_PATH, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

function summarize(alerts: AlertRecord[], days: number): AnyObj {
  const counts: Record<string, number> = {};
  for (const a of alerts) counts[a.category] = (counts[a.category] || 0) + 1;

  const byCat: Record<string, AnyObj> = {};
  for (const cat of VALID_CATEGORIES) {
    const catAlerts = alerts.filter((a) => a.category === cat);
    const total = catAlerts.length;
    const actions = catAlerts.filter((a) => a.led_to_action).length;
    const noise = catAlerts.filter((a) => a.noise_flagged).length;
    const precision = total ? actions / total : null;
    byCat[cat] = {
      total_alerts: total,
      alerts_that_led_to_action: actions,
      noise_flagged: noise,
      precision: precision == null ? null : Number(precision.toFixed(4)),
    };
  }

  const totalAlerts = alerts.length;
  const actionAlerts = alerts.filter((a) => a.led_to_action).length;
  const noiseTotal = alerts.filter((a) => a.noise_flagged).length;
  const overallPrecision = totalAlerts ? actionAlerts / totalAlerts : null;

  const topNoise = Object.entries(byCat)
    .filter(([, v]) => Number(v.total_alerts) >= 1 && (v.precision == null || Number(v.precision) < 0.35))
    .map(([cat, v]) => ({
      category: cat,
      total_alerts: v.total_alerts,
      action_alerts: v.alerts_that_led_to_action,
      precision: v.precision,
    }))
    .sort((a, b) => (b.total_alerts - a.total_alerts) || ((a.precision ?? -1) - (b.precision ?? -1)));

  const recommendations: string[] = [];
  const thresholds = loadThresholds();
  for (const cat of VALID_CATEGORIES) {
    const catStats = byCat[cat] || {};
    const precision = catStats.precision as number | null;
    const current = thresholds[cat];
    if (current == null) continue;

    if ((catStats.total_alerts || 0) === 0) {
      recommendations.push(`${cat}: no recent signal volume — keep threshold at ${current.toFixed(2)} until more data.`);
    } else if (precision != null && precision < 0.35) {
      const bump = Math.min(0.95, Math.round((current + 0.1) * 100) / 100);
      recommendations.push(`${cat}: low precision (${precision.toFixed(2)}); raise threshold ${current.toFixed(2)} -> ${bump.toFixed(2)}.`);
    } else if (precision != null && precision > 0.75 && (catStats.total_alerts || 0) >= 5) {
      const drop = Math.max(0.3, Math.round((current - 0.05) * 100) / 100);
      recommendations.push(`${cat}: high precision (${precision.toFixed(2)}); consider lowering threshold ${current.toFixed(2)} -> ${drop.toFixed(2)} for more recall.`);
    }
  }

  return {
    generated_at: new Date().toISOString(),
    window_days: days,
    overall: {
      total_alerts: totalAlerts,
      alerts_that_led_to_action: actionAlerts,
      noise_flagged_total: noiseTotal,
      precision: overallPrecision == null ? null : Number(overallPrecision.toFixed(4)),
    },
    counts_by_type: counts,
    per_category: byCat,
    top_noise_sources: topNoise,
    recommendations,
    sample_alerts: alerts.slice(-20).map((a) => ({
      timestamp: a.timestamp,
      category: a.category,
      source: a.source,
      event_type: a.event_type,
      message: a.message.slice(0, 140),
      noise_flagged: a.noise_flagged,
      led_to_action: a.led_to_action,
      task_id: a.task_id,
      task_status: a.task_status,
      user_response_within_30m: a.user_response_within_30m,
    })),
  };
}

function cmdAudit(days: number): number {
  const alerts = loadAlerts(days);
  const feedback = findNoiseFeedback(days);
  markNoiseFlags(alerts, feedback);
  const tasks = loadTasks(days);
  const userEvents = loadUserResponseEvents(days);
  correlateActions(alerts, tasks, userEvents);

  const result = summarize(alerts, days);
  fs.mkdirSync(path.dirname(LATEST_AUDIT_PATH), { recursive: true });
  fs.writeFileSync(LATEST_AUDIT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function cmdReport(): number {
  if (!fs.existsSync(LATEST_AUDIT_PATH)) {
    console.log("No audit report found. Run: signal_calibrator.py audit --days 30");
    return 1;
  }
  const data = JSON.parse(fs.readFileSync(LATEST_AUDIT_PATH, "utf8")) as AnyObj;
  const overall = data.overall || {};

  console.log("Signal Quality Summary");
  console.log("======================");
  console.log(`Window: last ${data.window_days} days`);
  console.log(`Total alerts: ${overall.total_alerts ?? 0}`);
  console.log(`Alerts with action: ${overall.alerts_that_led_to_action ?? 0}`);
  console.log(`Precision: ${overall.precision}`);
  console.log();
  console.log("Per-category precision");

  for (const cat of VALID_CATEGORIES) {
    const row = (data.per_category || {})[cat] || {};
    console.log(
      `- ${cat}: precision=${row.precision} (alerts=${row.total_alerts ?? 0}, actions=${row.alerts_that_led_to_action ?? 0}, noise=${row.noise_flagged ?? 0})`
    );
  }

  console.log();
  console.log("Top noise sources");
  const noise = data.top_noise_sources || [];
  if (!noise.length) {
    console.log("- none detected");
  } else {
    for (const n of noise) {
      console.log(`- ${n.category}: alerts=${n.total_alerts}, action_alerts=${n.action_alerts}, precision=${n.precision}`);
    }
  }

  console.log();
  console.log("Recommendations");
  const recs = data.recommendations || [];
  if (!recs.length) {
    console.log("- no threshold changes recommended");
  } else {
    for (const rec of recs) console.log(`- ${rec}`);
  }
  return 0;
}

function cmdTune(category: string, threshold: number): number {
  if (!VALID_CATEGORIES.includes(category)) throw new Error(`Invalid category '${category}'. Valid: ${VALID_CATEGORIES.join(", ")}`);
  if (threshold < 0 || threshold > 1) throw new Error("Threshold must be between 0 and 1.");

  const data = loadThresholds();
  for (const cat of VALID_CATEGORIES) if (!(cat in data)) data[cat] = 0.6;
  const old = data[category];
  data[category] = Number(threshold.toFixed(4));
  saveThresholds(data);

  console.log(
    JSON.stringify(
      {
        category,
        old_threshold: old,
        new_threshold: data[category],
        config_path: THRESHOLD_PATH,
      },
      null,
      2
    )
  );
  return 0;
}

function main(): number {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "audit") {
    const dIdx = argv.indexOf("--days");
    const days = dIdx >= 0 && argv[dIdx + 1] ? Number.parseInt(argv[dIdx + 1], 10) : 30;
    return cmdAudit(days);
  }
  if (cmd === "report") return cmdReport();
  if (cmd === "tune") {
    const cIdx = argv.indexOf("--category");
    const tIdx = argv.indexOf("--threshold");
    const category = cIdx >= 0 ? String(argv[cIdx + 1] || "") : "";
    const threshold = tIdx >= 0 ? Number.parseFloat(String(argv[tIdx + 1] || "")) : Number.NaN;
    if (!category || Number.isNaN(threshold)) {
      console.error("Usage: signal_calibrator.py tune --category <category> --threshold <0-1>");
      return 2;
    }
    return cmdTune(category, threshold);
  }

  console.error("Usage: signal_calibrator.py {audit|report|tune} [options]");
  return 2;
}

async function runMain(): Promise<void> {
  try {
    process.exit(main());
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(msg);
    process.exit(1);
  }
}

runMain();
