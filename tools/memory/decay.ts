#!/usr/bin/env npx tsx

import { runPsql } from "../lib/db.js";

type JsonRow = Record<string, any>;
const HALF_LIVES_DAYS: Record<string, number> = { fact: 365, preference: 180, event: 14, episodic: 14, system_rule: Infinity, rule: Infinity };

function run(sql: string): string {
  const p = runPsql(sql, { args: ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A"] });
  if (p.status !== 0) throw new Error((p.stderr || p.stdout || "psql failed").trim());
  return (p.stdout || "").trim();
}
const parse = (raw: string): JsonRow[] => { try { const x = JSON.parse(raw || "[]"); return Array.isArray(x) ? x : []; } catch { return []; } };
const sf = (v: any, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const si = (v: any, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const recency = (days: number, t: string) => { const h = HALF_LIVES_DAYS[(t || "fact").toLowerCase()] ?? HALF_LIVES_DAYS.fact; return Number.isFinite(h) ? 2 ** (-(Math.max(0, sf(days)) / h)) : 1; };
const utility = (access: number) => Math.log10(Math.max(0, si(access)) + 1);

function ensureSchema() { run(`ALTER TABLE cortana_memory_semantic ADD COLUMN IF NOT EXISTS access_count INT NOT NULL DEFAULT 0; ALTER TABLE cortana_memory_semantic ADD COLUMN IF NOT EXISTS supersedes_id BIGINT; ALTER TABLE cortana_memory_semantic ADD COLUMN IF NOT EXISTS superseded_by BIGINT; ALTER TABLE cortana_memory_semantic ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;`); }

function getChain(id: number): JsonRow[] {
  return parse(run(`WITH RECURSIVE walk AS (SELECT id,supersedes_id,superseded_by,0::int AS depth_back FROM cortana_memory_semantic WHERE id=${id} UNION ALL SELECT p.id,p.supersedes_id,p.superseded_by,walk.depth_back+1 FROM cortana_memory_semantic p JOIN walk ON walk.supersedes_id=p.id), oldest AS (SELECT id FROM walk ORDER BY depth_back DESC LIMIT 1), chain AS (SELECT s.id,s.supersedes_id,s.superseded_by,s.superseded_at,s.first_seen_at,s.last_seen_at,s.fact_type,s.subject,s.predicate,s.object_value,0::int AS depth FROM cortana_memory_semantic s JOIN oldest o ON o.id=s.id UNION ALL SELECT n.id,n.supersedes_id,n.superseded_by,n.superseded_at,n.first_seen_at,n.last_seen_at,n.fact_type,n.subject,n.predicate,n.object_value,chain.depth+1 FROM cortana_memory_semantic n JOIN chain ON n.supersedes_id=chain.id) SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.depth ASC),'[]'::json)::text FROM chain t;`));
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd || !["stats", "chain"].includes(cmd)) { console.error("usage: decay.ts {stats|chain <memory_id>}"); process.exit(2); }
  ensureSchema();
  if (cmd === "chain") { console.log(JSON.stringify({ memory_id: Number(arg), chain: getChain(Number(arg)) }, null, 2)); return; }
  const rows = parse(run(`WITH sem AS (SELECT fact_type AS memory_type,COUNT(*) AS total,COUNT(*) FILTER (WHERE superseded_by IS NOT NULL OR superseded_at IS NOT NULL) AS superseded,AVG(GREATEST(EXTRACT(EPOCH FROM (NOW()-COALESCE(last_seen_at,first_seen_at)))/86400.0,0.0)) AS avg_days_old,AVG(access_count)::float AS avg_access FROM cortana_memory_semantic WHERE active=TRUE GROUP BY fact_type), epi AS (SELECT 'episodic'::text AS memory_type,COUNT(*) AS total,0::bigint AS superseded,AVG(GREATEST(EXTRACT(EPOCH FROM (NOW()-happened_at))/86400.0,0.0)) AS avg_days_old,0.0::float AS avg_access FROM cortana_memory_episodic WHERE active=TRUE) SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.memory_type),'[]'::json)::text FROM (SELECT * FROM sem UNION ALL SELECT * FROM epi) t;`));
  const distribution = rows.map((r) => ({ ...r, half_life_days: Number.isFinite(HALF_LIVES_DAYS[r.memory_type] ?? HALF_LIVES_DAYS.fact) ? (HALF_LIVES_DAYS[r.memory_type] ?? HALF_LIVES_DAYS.fact) : "never", avg_recency_score: Number(recency(sf(r.avg_days_old), r.memory_type).toFixed(6)), avg_utility_score: Number(utility(si(r.avg_access)).toFixed(6)) }));
  console.log(JSON.stringify({ distribution }, null, 2));
}
main().catch((e)=>{ console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
