#!/usr/bin/env npx tsx


const DB = "cortana";
const ACTED = new Set(["accepted", "completed", "in_progress", "acted"]);
const DISMISSED = new Set(["dismissed", "cancelled", "rejected", "ignored"]);

type Outcome = {
  signal_id: number;
  signal_type: string;
  confidence: number;
  bucket: string;
  task_created: boolean;
  outcome: string;
};

type Json = Record<string, any>;

function runPsqlQuery(sql: string): string {
  const result = runPsql(sql, { db: DB, args: ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A"], env: withPostgresPath(process.env) });
  if (result.status !== 0) {
    const err = (result.stderr || "psql failed").toString().trim();
    throw new Error(err || "psql failed");
  }
  return (result.stdout || "").toString().trim();
}

function fetchJson(sql: string): Json[] {
  const raw = runPsqlQuery(`SELECT COALESCE(json_agg(t),'[]'::json)::text FROM (${sql}) t;`);
  return raw ? (JSON.parse(raw) as Json[]) : [];
}

function exists(name: string): boolean {
  const escaped = name.replace(/'/g, "''");
  const raw = runPsqlQuery(`SELECT to_regclass('${escaped}') IS NOT NULL;`) || "";
  return raw.trim().toLowerCase() === "t";
}

function hasCol(table: string, col: string): boolean {
  const t = table.replace(/'/g, "''");
  const c = col.replace(/'/g, "''");
  const q =
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns " +
    `WHERE table_schema='public' AND table_name='${t}' ` +
    `AND column_name='${c}');`;
  const raw = runPsqlQuery(q) || "";
  return raw.trim().toLowerCase() === "t";
}

function bucket(confidence: number): string {
  if (confidence < 0.5) return "0.00-0.49";
  if (confidence < 0.65) return "0.50-0.64";
  if (confidence < 0.8) return "0.65-0.79";
  return "0.80-1.00";
}

function loadSignals(days: number): Json[] {
  let rows: Json[] = [];
  if (exists("cortana_proactive_signals")) {
    const tsCol = hasCol("cortana_proactive_signals", "created_at")
      ? "created_at"
      : hasCol("cortana_proactive_signals", "timestamp")
      ? "timestamp"
      : null;
    const where = tsCol ? `WHERE ${tsCol}>=NOW()-INTERVAL '${Math.trunc(days)} days'` : "";
    rows = rows.concat(
      fetchJson(
        `SELECT id signal_id,COALESCE(signal_type,'unknown') signal_type,COALESCE(confidence,0)::float8 confidence,metadata FROM cortana_proactive_signals ${where} ORDER BY id DESC`
      )
    );
  }
  if (rows.length < 10) {
    rows = rows.concat(
      fetchJson(
        `SELECT id signal_id,COALESCE(metadata->>'signal_type',metadata->>'type','unknown') signal_type,COALESCE(NULLIF(metadata->>'confidence','')::float8,0.0) confidence,metadata FROM cortana_events WHERE timestamp>=NOW()-INTERVAL '${Math.trunc(days)} days' AND (source ILIKE 'proactive%' OR event_type ILIKE 'proactive%') ORDER BY id DESC`
      )
    );
  }
  const dedup = new Map<number, Json>();
  for (const r of rows) {
    const sid = Number(r.signal_id || 0);
    if (sid > 0 && !dedup.has(sid)) dedup.set(sid, r);
  }
  return Array.from(dedup.values());
}

function loadSuggestion(days: number): Map<number, Json> {
  if (!exists("cortana_proactive_suggestions")) return new Map();
  const tsCol = hasCol("cortana_proactive_suggestions", "created_at")
    ? "created_at"
    : hasCol("cortana_proactive_suggestions", "timestamp")
    ? "timestamp"
    : null;
  const where = tsCol ? `WHERE ${tsCol}>=NOW()-INTERVAL '${Math.trunc(days)} days'` : "";
  const rows = fetchJson(
    `SELECT id,status,metadata FROM cortana_proactive_suggestions ${where} ORDER BY id DESC`
  );
  const out = new Map<number, Json>();
  for (const r of rows) {
    const md = r.metadata && typeof r.metadata === "object" ? r.metadata : {};
    const sid = Number(md.signal_id || -1);
    if (sid > 0 && !out.has(sid)) out.set(sid, r);
  }
  return out;
}

function loadTasks(days: number): [Set<number>, Map<number, string>] {
  if (!exists("cortana_tasks")) return [new Set(), new Map()];
  const tsCol = hasCol("cortana_tasks", "created_at")
    ? "created_at"
    : hasCol("cortana_tasks", "timestamp")
    ? "timestamp"
    : null;
  const where = tsCol ? `${tsCol}>=NOW()-INTERVAL '${Math.trunc(days)} days' AND ` : "";
  const rows = fetchJson(
    `SELECT status,metadata FROM cortana_tasks WHERE ${where} source='proactive-detector'`
  );
  const created = new Set<number>();
  const outcomes = new Map<number, string>();
  for (const r of rows) {
    const md = r.metadata && typeof r.metadata === "object" ? r.metadata : {};
    const sid = Number(md.signal_id || -1);
    if (sid <= 0) continue;
    created.add(sid);
    const st = String(r.status || "").toLowerCase();
    if (st === "completed") outcomes.set(sid, "acted");
    else if (st === "cancelled" || st === "dismissed" || st === "rejected") outcomes.set(sid, "dismissed");
    else if (!outcomes.has(sid)) outcomes.set(sid, "ready");
  }
  return [created, outcomes];
}

function build(days: number): Outcome[] {
  const sigs = loadSignals(days);
  const smap = loadSuggestion(days);
  const [created, outcomes] = loadTasks(days);

  const out: Outcome[] = [];
  for (const s of sigs) {
    const sid = Number(s.signal_id || 0);
    if (sid <= 0) continue;
    const conf = Number(s.confidence || 0.0);
    let state = outcomes.get(sid) || "unknown";
    const sg = smap.get(sid);
    if (sg && (state === "unknown" || state === "ready")) {
      const ss = String(sg.status || "").toLowerCase();
      if (ACTED.has(ss)) state = "acted";
      else if (DISMISSED.has(ss)) state = "dismissed";
      else if (ss) state = "ready";
    }
    out.push({
      signal_id: sid,
      signal_type: String(s.signal_type || "unknown"),
      confidence: conf,
      bucket: bucket(conf),
      task_created: created.has(sid),
      outcome: state,
    });
  }
  return out;
}

function summarize(items: Outcome[], target: number, minSupport: number): Json {
  const by = new Map<string, Outcome[]>();
  for (const o of items) {
    const key = `${o.signal_type}|${o.bucket}`;
    by.set(key, [...(by.get(key) || []), o]);
  }

  const metrics: Json[] = [];
  for (const [key, rows] of Array.from(by.entries()).sort()) {
    const [signalType, confidenceBucket] = key.split("|");
    const acted = rows.filter((r) => r.outcome === "acted").length;
    const dismissed = rows.filter((r) => r.outcome === "dismissed").length;
    const pending = rows.filter((r) => r.outcome !== "acted" && r.outcome !== "dismissed").length;
    const denom = acted + dismissed;
    const prec = denom ? acted / denom : null;
    metrics.push({
      signal_type: signalType,
      confidence_bucket: confidenceBucket,
      support: rows.length,
      acted,
      dismissed,
      pending_or_unknown: pending,
      task_created: rows.filter((r) => r.task_created).length,
      precision: prec != null ? Number(prec.toFixed(3)) : null,
    });
  }

  const low: Record<string, number> = {
    "0.00-0.49": 0.0,
    "0.50-0.64": 0.5,
    "0.65-0.79": 0.65,
    "0.80-1.00": 0.8,
  };

  const byType = new Map<string, Json[]>();
  for (const m of metrics) {
    byType.set(m.signal_type, [...(byType.get(m.signal_type) || []), m]);
  }

  const rec: Json[] = [];
  for (const [signalType, rows] of byType.entries()) {
    const sorted = [...rows].sort((a, b) => low[b.confidence_bucket] - low[a.confidence_bucket]);
    let chosen: Json | undefined;
    for (const r of sorted) {
      if (r.support >= minSupport && r.precision != null && r.precision >= target) {
        chosen = r;
        break;
      }
    }
    rec.push({
      signal_type: signalType,
      recommended_min_confidence: chosen ? low[chosen.confidence_bucket] : 0.8,
      reason: chosen
        ? `precision ${Number(chosen.precision).toFixed(2)} support ${chosen.support} in ${chosen.confidence_bucket}`
        : "insufficient high-precision evidence; tighten to 0.80",
    });
  }

  const oa = items.filter((i) => i.outcome === "acted").length;
  const od = items.filter((i) => i.outcome === "dismissed").length;
  const d = oa + od;

  return {
    generated_at: new Date().toISOString().replace("Z", "+00:00"),
    signals_analyzed: items.length,
    outcomes_with_decision: d,
    overall_precision: d ? Number((oa / d).toFixed(3)) : null,
    metrics,
    recommendations: rec,
  };
}

function writeEvent(summary: Json, dry: boolean): void {
  if (dry) return;
  const sev = summary.overall_precision != null && summary.overall_precision < 0.45 ? "warning" : "info";
  const payload = JSON.stringify(summary).replace(/'/g, "''");
  runPsqlQuery(
    `INSERT INTO cortana_events (event_type,source,severity,message,metadata) VALUES ('proactive_calibration','evaluate_accuracy.py','${sev}','Proactive calibration complete','${payload}'::jsonb);`
  );
}

function usageError(): never {
  console.error("usage: evaluate_accuracy.py [--days N] [--target-precision X] [--min-support N] [--dry-run]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getNum = (flag: string, def: number): number => {
    const idx = args.indexOf(flag);
    if (idx >= 0 && args[idx + 1]) return Number(args[idx + 1]);
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return Number(eq.slice(flag.length + 1));
    return def;
  };

  const days = getNum("--days", 30);
  const targetPrecision = getNum("--target-precision", 0.6);
  const minSupport = getNum("--min-support", 3);
  const dryRun = args.includes("--dry-run");

  if (Number.isNaN(days) || Number.isNaN(targetPrecision) || Number.isNaN(minSupport)) {
    usageError();
  }

  const items = build(days);
  const summary = summarize(items, targetPrecision, minSupport);
  writeEvent(summary, dryRun);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
