#!/usr/bin/env npx tsx

import { spawnSync } from "child_process";
import db from "../lib/db.js";
const { withPostgresPath } = db;

const DB_NAME = "cortana";
const sqlQuote = (s = "") => `'${s.replace(/'/g, "''")}'`;
const die = (m: string): never => { console.log(JSON.stringify({ ok: false, error: m })); process.exit(1); };

async function main(): Promise<void> {
  let session = "";
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--session") session = args[++i] || "";
    else if (a === "-h" || a === "--help") { console.log("Usage:\n  council-tally.sh --session <UUID>"); process.exit(0); }
    else die(`Unknown arg: ${a}`);
  }
  if (!session) die("Missing --session");

  const sql = `
WITH s AS (
  SELECT * FROM cortana_council_sessions WHERE id = ${sqlQuote(session)}::uuid
), votes AS (
  SELECT * FROM cortana_council_votes WHERE session_id = ${sqlQuote(session)}::uuid
), agg AS (
  SELECT
    COUNT(*)::int AS total_votes,
    COUNT(*) FILTER (WHERE vote='approve')::int AS approve_count,
    COUNT(*) FILTER (WHERE vote='reject')::int AS reject_count,
    COUNT(*) FILTER (WHERE vote='abstain')::int AS abstain_count,
    COALESCE(AVG(confidence), 0)::float AS avg_confidence,
    COALESCE(SUM(token_cost), 0)::int AS total_token_cost,
    COALESCE(SUM(CASE WHEN vote='approve' THEN COALESCE(confidence, 0.5) ELSE 0 END), 0)::float AS approve_weight,
    COALESCE(SUM(CASE WHEN vote='reject' THEN COALESCE(confidence, 0.5) ELSE 0 END), 0)::float AS reject_weight
  FROM votes
), decision_obj AS (
  SELECT jsonb_build_object(
      'outcome', CASE
        WHEN a.total_votes = 0 THEN 'abstain'
        WHEN a.approve_weight > a.reject_weight THEN 'approved'
        WHEN a.reject_weight > a.approve_weight THEN 'rejected'
        WHEN a.approve_count > a.reject_count THEN 'approved'
        WHEN a.reject_count > a.approve_count THEN 'rejected'
        ELSE 'abstain'
      END,
      'method', 'majority_plus_confidence_weight',
      'totals', jsonb_build_object(
        'total_votes', a.total_votes,
        'approve', a.approve_count,
        'reject', a.reject_count,
        'abstain', a.abstain_count,
        'avg_confidence', a.avg_confidence,
        'total_token_cost', a.total_token_cost,
        'approve_weight', a.approve_weight,
        'reject_weight', a.reject_weight
      ),
      'generated_at', now()
    ) AS decision
  FROM agg a
), upd AS (
  UPDATE cortana_council_sessions cs
  SET status='decided', decided_at=now(), decision=d.decision
  FROM decision_obj d
  WHERE cs.id = ${sqlQuote(session)}::uuid
  RETURNING cs.*, d.decision AS tally_decision
), ins_evt AS (
  INSERT INTO cortana_council_events (session_id, event_type, payload)
  SELECT ${sqlQuote(session)}::uuid, 'session_tallied', u.tally_decision
  FROM upd u
  RETURNING id
)
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM s) THEN json_build_object('ok', false, 'error', 'Session not found')
  ELSE json_build_object(
      'ok', true,
      'action', 'tally',
      'session_id', ${sqlQuote(session)},
      'summary', (SELECT decision FROM decision_obj),
      'session', (SELECT (to_jsonb(upd) - 'tally_decision')::json FROM upd LIMIT 1),
      'votes', COALESCE((SELECT json_agg(v ORDER BY v.voted_at) FROM votes v), '[]'::json)
    )
END::text;`;

  const r = spawnSync("psql", [DB_NAME, "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql], { encoding: "utf8", env: withPostgresPath(process.env) });
  if (r.status !== 0) die("Failed to tally session");
  console.log((r.stdout || "").trim());
}

main();
