#!/usr/bin/env npx tsx

import { spawnSync } from "child_process";
const DB_NAME = "cortana";

function sqlQuote(s = ""): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function jsonError(msg: string): string {
  return JSON.stringify({ ok: false, error: msg });
}

function die(msg: string): never {
  console.log(jsonError(msg));
  process.exit(1);
}

function usage(): void {
  console.log(`Usage:
  council.sh create --type <approval|deliberation|eval_gate> --title <title> --initiator <name> --participants "a,b" --expires <minutes> [--context <json>]
  council.sh vote --session <uuid> --voter <name> --vote <approve|reject|abstain> [--confidence <0-1>] [--reasoning <text>] [--model <name>] [--tokens <int>]
  council.sh decide --session <uuid> --decision <json>
  council.sh status --session <uuid>
  council.sh list [--status <status>] [--type <type>]
  council.sh expire`);
}

function runSql(sql: string): string {
  const r = spawnSync("psql", [DB_NAME, "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql], {
    encoding: "utf8",
    env: withPostgresPath(process.env),
  });
  if (r.status !== 0) throw new Error(r.stderr || "psql failed");
  return (r.stdout || "").trim();
}

function logEvent(sessionId: string, eventType: string, payloadJson: string): void {
  runSql(`INSERT INTO cortana_council_events (session_id, event_type, payload) VALUES (${sqlQuote(sessionId)}::uuid, ${sqlQuote(eventType)}, ${sqlQuote(payloadJson)}::jsonb);`);
}

function parseArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const k = args[i];
    if (!k.startsWith("--") || i + 1 >= args.length) {
      throw new Error(`Unknown arg: ${k}`);
    }
    out[k] = args[i + 1];
    i += 1;
  }
  return out;
}

function cmdCreate(args: string[]): void {
  let m: Record<string, string>;
  try { m = parseArgs(args); } catch (e) { die((e as Error).message.replace("Unknown arg:", "Unknown arg for create:")); }
  const type = m["--type"] || "";
  const title = m["--title"] || "";
  const initiator = m["--initiator"] || "";
  const participants = m["--participants"] || "";
  const expires = m["--expires"] || "";
  const context = m["--context"] || "{}";
  if (!(type && title && initiator && participants && expires)) die("Missing required args for create");
  if (!/^\d+$/.test(expires)) die("--expires must be an integer number of minutes");

  let out = "";
  try {
    out = runSql(`
    WITH ins AS (
      INSERT INTO cortana_council_sessions (type, title, initiator, participants, expires_at, context)
      VALUES (
        ${sqlQuote(type)},
        ${sqlQuote(title)},
        ${sqlQuote(initiator)},
        regexp_split_to_array(${sqlQuote(participants)}, '\\s*,\\s*'),
        now() + (${sqlQuote(expires)}::int || ' minutes')::interval,
        ${sqlQuote(context)}::jsonb
      )
      RETURNING *
    )
    SELECT json_build_object('ok', true, 'action', 'create', 'session', row_to_json(ins))::text FROM ins;
  `);
  } catch {
    die("Failed to create session");
  }
  const obj = JSON.parse(out);
  logEvent(obj.session.id, "session_created", JSON.stringify({ type, initiator }));
  console.log(out);
}

function cmdVote(args: string[]): void {
  let m: Record<string, string>;
  try { m = parseArgs(args); } catch (e) { die((e as Error).message.replace("Unknown arg:", "Unknown arg for vote:")); }
  const session = m["--session"] || "";
  const voter = m["--voter"] || "";
  const vote = m["--vote"] || "";
  const confidence = m["--confidence"];
  const reasoning = m["--reasoning"];
  const model = m["--model"];
  const tokens = m["--tokens"];
  if (!(session && voter && vote)) die("Missing required args for vote");
  if (tokens && !/^\d+$/.test(tokens)) die("--tokens must be integer");

  const confExpr = confidence ? `${sqlQuote(confidence)}::float` : "NULL";
  const reasonExpr = reasoning ? sqlQuote(reasoning) : "NULL";
  const modelExpr = model ? sqlQuote(model) : "NULL";
  const tokensExpr = tokens ? `${sqlQuote(tokens)}::int` : "NULL";

  let out = "";
  try {
    out = runSql(`
    WITH chk AS (
      SELECT id, status FROM cortana_council_sessions WHERE id = ${sqlQuote(session)}::uuid
    ), ins AS (
      INSERT INTO cortana_council_votes (session_id, voter, vote, confidence, reasoning, model_used, token_cost)
      SELECT ${sqlQuote(session)}::uuid, ${sqlQuote(voter)}, ${sqlQuote(vote)}, ${confExpr}, ${reasonExpr}, ${modelExpr}, ${tokensExpr}
      FROM chk WHERE chk.status IN ('open','voting')
      RETURNING *
    ), upd AS (
      UPDATE cortana_council_sessions SET status='voting' WHERE id=${sqlQuote(session)}::uuid AND status='open' RETURNING id
    )
    SELECT CASE
      WHEN NOT EXISTS (SELECT 1 FROM chk) THEN json_build_object('ok', false, 'error', 'Session not found')
      WHEN (SELECT status FROM chk LIMIT 1) NOT IN ('open','voting') THEN json_build_object('ok', false, 'error', 'Session is not accepting votes')
      WHEN NOT EXISTS (SELECT 1 FROM ins) THEN json_build_object('ok', false, 'error', 'Vote not recorded')
      ELSE json_build_object('ok', true, 'action', 'vote', 'vote', (SELECT row_to_json(ins) FROM ins LIMIT 1))
    END::text;
  `);
  } catch {
    die("Failed to cast vote");
  }
  const parsed = JSON.parse(out);
  if (parsed.ok) logEvent(session, "vote_cast", JSON.stringify({ voter, vote }));
  console.log(out);
}

function cmdDecide(args: string[]): void {
  let m: Record<string, string>;
  try { m = parseArgs(args); } catch (e) { die((e as Error).message.replace("Unknown arg:", "Unknown arg for decide:")); }
  const session = m["--session"] || "";
  const decision = m["--decision"] || "";
  if (!(session && decision)) die("Missing required args for decide");
  let out = "";
  try {
    out = runSql(`
    WITH upd AS (
      UPDATE cortana_council_sessions
      SET status='decided', decision=${sqlQuote(decision)}::jsonb, decided_at=now()
      WHERE id=${sqlQuote(session)}::uuid
      RETURNING *
    )
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM upd) THEN json_build_object('ok', true, 'action', 'decide', 'session', (SELECT row_to_json(upd) FROM upd LIMIT 1))
      ELSE json_build_object('ok', false, 'error', 'Session not found')
    END::text;
  `);
  } catch {
    die("Failed to update decision");
  }
  if (JSON.parse(out).ok) logEvent(session, "session_decided", decision);
  console.log(out);
}

function cmdStatus(args: string[]): void {
  let m: Record<string, string>;
  try { m = parseArgs(args); } catch (e) { die((e as Error).message.replace("Unknown arg:", "Unknown arg for status:")); }
  const session = m["--session"] || "";
  if (!session) die("Missing --session");
  try {
    const out = runSql(`
    WITH s AS (
      SELECT * FROM cortana_council_sessions WHERE id=${sqlQuote(session)}::uuid
    )
    SELECT CASE
      WHEN NOT EXISTS (SELECT 1 FROM s) THEN json_build_object('ok', false, 'error', 'Session not found')
      ELSE json_build_object(
        'ok', true,
        'action', 'status',
        'session', (SELECT row_to_json(s) FROM s LIMIT 1),
        'votes', COALESCE((SELECT json_agg(v ORDER BY v.voted_at) FROM cortana_council_votes v WHERE v.session_id=${sqlQuote(session)}::uuid), '[]'::json),
        'events', COALESCE((SELECT json_agg(e ORDER BY e.created_at) FROM cortana_council_events e WHERE e.session_id=${sqlQuote(session)}::uuid), '[]'::json)
      )
    END::text;
  `);
    console.log(out);
  } catch {
    die("Failed to fetch status");
  }
}

function cmdList(args: string[]): void {
  let m: Record<string, string> = {};
  try { m = parseArgs(args); } catch (e) { die((e as Error).message.replace("Unknown arg:", "Unknown arg for list:")); }
  const status = m["--status"];
  const type = m["--type"];
  const statusCond = status ? `status = ${sqlQuote(status)}` : "TRUE";
  const typeCond = type ? `type = ${sqlQuote(type)}` : "TRUE";
  try {
    const out = runSql(`
    SELECT json_build_object(
      'ok', true,
      'action', 'list',
      'sessions', COALESCE(json_agg(s ORDER BY s.created_at DESC), '[]'::json)
    )::text
    FROM (
      SELECT * FROM cortana_council_sessions
      WHERE ${statusCond} AND ${typeCond}
      ORDER BY created_at DESC
      LIMIT 200
    ) s;
  `);
    console.log(out);
  } catch {
    die("Failed to list sessions");
  }
}

function cmdExpire(): void {
  try {
    const out = runSql(`
    WITH exp AS (
      UPDATE cortana_council_sessions
      SET status='expired'
      WHERE status IN ('open','voting') AND expires_at < now()
      RETURNING id
    ), ev AS (
      INSERT INTO cortana_council_events (session_id, event_type, payload)
      SELECT id, 'session_expired', '{"reason":"expires_at_passed"}'::jsonb FROM exp
      RETURNING session_id
    )
    SELECT json_build_object(
      'ok', true,
      'action', 'expire',
      'expired_count', (SELECT count(*) FROM exp),
      'session_ids', COALESCE((SELECT json_agg(id) FROM exp), '[]'::json)
    )::text;
  `);
    console.log(out);
  } catch {
    die("Failed to expire sessions");
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    usage();
    process.exit(1);
  }
  switch (cmd) {
    case "create": cmdCreate(rest); break;
    case "vote": cmdVote(rest); break;
    case "decide": cmdDecide(rest); break;
    case "status": cmdStatus(rest); break;
    case "list": cmdList(rest); break;
    case "expire": cmdExpire(); break;
    case "-h":
    case "--help":
    case "help": usage(); break;
    default: die(`Unknown command: ${cmd}`);
  }
}

main();
