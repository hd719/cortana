#!/usr/bin/env npx tsx
import { queryJson } from "../lib/db.js";
type Overview = {
  window_days: number;
  generated_at: string;
  cron_sla_7d: number | null;
  cron_sla_prev_7d: number | null;
  cron_sla_delta: number | null;
  incident_count_7d: number;
  mttr_minutes_7d: number | null;
  open_human_required_count: number;
};

type OpenFollowUp = { id: number; title: string; system: string | null; severity: string | null };

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(current: number | null, prev: number | null): number | null {
  if (current === null || prev === null) return null;
  return Number((current - prev).toFixed(2));
}

function fetchOverview(windowDays: number): Overview {
  const [row] = queryJson<any>(`
    WITH params AS (
      SELECT ${windowDays}::int AS wd
    ),
    sla_curr AS (
      SELECT
        CASE WHEN COUNT(*) = 0 THEN NULL
             ELSE ROUND((SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::numeric / COUNT(*)) * 100, 2)
        END AS v
      FROM cortana_cron_health, params
      WHERE timestamp >= NOW() - (params.wd || ' days')::interval
    ),
    sla_prev AS (
      SELECT
        CASE WHEN COUNT(*) = 0 THEN NULL
             ELSE ROUND((SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::numeric / COUNT(*)) * 100, 2)
        END AS v
      FROM cortana_cron_health, params
      WHERE timestamp >= NOW() - ((params.wd * 2) || ' days')::interval
        AND timestamp < NOW() - (params.wd || ' days')::interval
    ),
    incidents AS (
      SELECT COUNT(*)::int AS c
      FROM cortana_events, params
      WHERE timestamp >= NOW() - (params.wd || ' days')::interval
        AND severity IN ('warning','error','critical')
    ),
    mttr AS (
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - detected_at)) / 60.0)::numeric, 2) AS m
      FROM cortana_immune_incidents, params
      WHERE detected_at >= NOW() - (params.wd || ' days')::interval
        AND resolved_at IS NOT NULL
    ),
    risks AS (
      SELECT COUNT(*)::int AS c
      FROM cortana_human_required_actions
      WHERE status = 'open'
    )
    SELECT json_build_object(
      'window_days', (SELECT wd FROM params),
      'generated_at', NOW()::text,
      'cron_sla_7d', (SELECT v FROM sla_curr),
      'cron_sla_prev_7d', (SELECT v FROM sla_prev),
      'incident_count_7d', (SELECT c FROM incidents),
      'mttr_minutes_7d', (SELECT m FROM mttr),
      'open_human_required_count', (SELECT c FROM risks)
    );
  `);

  const cronCurr = num(row?.cron_sla_7d);
  const cronPrev = num(row?.cron_sla_prev_7d);

  return {
    window_days: Number(row?.window_days ?? windowDays),
    generated_at: String(row?.generated_at ?? new Date().toISOString()),
    cron_sla_7d: cronCurr,
    cron_sla_prev_7d: cronPrev,
    cron_sla_delta: pct(cronCurr, cronPrev),
    incident_count_7d: Number(row?.incident_count_7d ?? 0),
    mttr_minutes_7d: num(row?.mttr_minutes_7d),
    open_human_required_count: Number(row?.open_human_required_count ?? 0),
  };
}

function fetchOpenFollowUps(limit: number): OpenFollowUp[] {
  return queryJson<OpenFollowUp>(`
    SELECT COALESCE(json_agg(t), '[]'::json)
    FROM (
      SELECT
        id,
        title,
        system,
        severity
      FROM cortana_human_required_actions
      WHERE status = 'open'
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               due_at ASC NULLS LAST,
               last_seen_at DESC
      LIMIT ${Math.max(1, Math.min(limit, 10))}
    ) t;
  `);
}

export function renderDigest(overview: Overview, openFollowUps: OpenFollowUp[]): string {
  const trend = overview.cron_sla_delta === null
    ? "n/a"
    : `${overview.cron_sla_delta > 0 ? "+" : ""}${overview.cron_sla_delta.toFixed(2)}pp`;

  const mttr = overview.mttr_minutes_7d === null ? "n/a" : `${overview.mttr_minutes_7d.toFixed(1)}m`;

  const lines = [
    "🛡️ Weekly Reliability Digest",
    `• Cron SLA (7d): ${overview.cron_sla_7d ?? "n/a"}% (prev ${overview.cron_sla_prev_7d ?? "n/a"}%, trend ${trend})`,
    `• Incidents (warn/error/critical, 7d): ${overview.incident_count_7d}`,
    `• MTTR (resolved immune incidents, 7d): ${mttr}`,
    `• Open human-required items: ${overview.open_human_required_count}`,
  ];

  if (openFollowUps.length > 0) {
    lines.push("• Top human-required items:");
    for (const r of openFollowUps) {
      lines.push(`  - #${r.id} [${r.severity ?? "NA"}] ${r.title}${r.system ? ` (${r.system})` : ""}`);
    }
  }

  return lines.join("\n");
}

export function main(): void {
  const args = new Set(process.argv.slice(2));
  const windowDays = Number(process.env.RELIABILITY_DIGEST_WINDOW_DAYS ?? 7);
  const riskLimit = Number(process.env.RELIABILITY_DIGEST_RISK_LIMIT ?? 3);

  const overview = fetchOverview(Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 7);
  const openFollowUps = fetchOpenFollowUps(Number.isFinite(riskLimit) && riskLimit > 0 ? riskLimit : 3);
  const digest = renderDigest(overview, openFollowUps);

  if (args.has("--json")) {
    process.stdout.write(`${JSON.stringify({ overview, openFollowUps, digest }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${digest}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
