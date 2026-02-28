#!/usr/bin/env npx tsx

import fs from "fs";
import { query } from "../lib/db.js";

const ACTION = new Set([
  "must",
  "should",
  "need",
  "todo",
  "remember",
  "prefer",
  "rule",
  "plan",
  "schedule",
  "review",
  "fix",
  "send",
  "build",
]);
const LONG = new Set([
  "always",
  "never",
  "preference",
  "policy",
  "rule",
  "habit",
  "routine",
  "goal",
  "weekly",
  "monthly",
  "career",
  "health",
  "finance",
]);
const SHORT = new Set(["today", "tomorrow", "asap", "immediately", "now", "temporary", "one-time"]);
const NEG = [" not ", " never ", " no ", " don't ", " do not ", " avoid ", " stop "];

type Candidate = {
  text: string;
  source_type: string;
  source_ref: string | null;
  timestamp: string | null;
};

type MatchBlock = { i: number; j: number; size: number };

function runPsql(sql: string): string {
  return query(sql).trim();
}

function fetchJson(sql: string): Array<Record<string, any>> {
  const raw = runPsql(`SELECT COALESCE(json_agg(t),'[]'::json)::text FROM (${sql}) t;`);
  return raw ? (JSON.parse(raw) as Array<Record<string, any>>) : [];
}

function toks(t: string): Set<string> {
  const matches = t.match(/[A-Za-z][A-Za-z0-9_'-]{2,}/g) ?? [];
  return new Set(matches.map((m) => m.toLowerCase()));
}

function buildB2j(b: string[], autojunk = true): Map<string, number[]> {
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < b.length; i += 1) {
    const elt = b[i];
    const arr = b2j.get(elt);
    if (arr) arr.push(i);
    else b2j.set(elt, [i]);
  }
  if (autojunk && b.length >= 200) {
    const ntest = Math.floor(b.length / 100) + 1;
    for (const [elt, idxs] of b2j.entries()) {
      if (idxs.length > ntest) {
        b2j.delete(elt);
      }
    }
  }
  return b2j;
}

function findLongestMatch(
  a: string[],
  b: string[],
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
  b2j: Map<string, number[]>
): MatchBlock {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();

  for (let i = alo; i < ahi; i += 1) {
    const newj2len = new Map<number, number>();
    const indices = b2j.get(a[i]) ?? [];
    for (const j of indices) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }

  return { i: besti, j: bestj, size: bestsize };
}

function getMatchingBlocks(a: string[], b: string[]): MatchBlock[] {
  const la = a.length;
  const lb = b.length;
  const b2j = buildB2j(b);
  const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
  const matching: MatchBlock[] = [];

  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
    const match = findLongestMatch(a, b, alo, ahi, blo, bhi, b2j);
    if (match.size) {
      if (alo < match.i && blo < match.j) {
        queue.push([alo, match.i, blo, match.j]);
      }
      if (match.i + match.size < ahi && match.j + match.size < bhi) {
        queue.push([match.i + match.size, ahi, match.j + match.size, bhi]);
      }
      matching.push(match);
    }
  }

  matching.sort((x, y) => (x.i - y.i) || (x.j - y.j));
  const nonAdjacent: MatchBlock[] = [];
  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  for (const m of matching) {
    if (m.i === i1 + k1 && m.j === j1 + k1) {
      k1 += m.size;
    } else {
      if (k1) nonAdjacent.push({ i: i1, j: j1, size: k1 });
      i1 = m.i;
      j1 = m.j;
      k1 = m.size;
    }
  }
  if (k1) nonAdjacent.push({ i: i1, j: j1, size: k1 });
  nonAdjacent.push({ i: la, j: lb, size: 0 });
  return nonAdjacent;
}

function sequenceMatcherRatio(a: string, b: string): number {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;
  const aa = a.split("");
  const bb = b.split("");
  const blocks = getMatchingBlocks(aa, bb);
  const matches = blocks.reduce((sum, blk) => sum + blk.size, 0);
  return (2.0 * matches) / (aa.length + bb.length);
}

function sim(a: string, b: string): number {
  if (!a || !b) return 0.0;
  const seq = sequenceMatcherRatio(a.toLowerCase(), b.toLowerCase());
  const ta = toks(a);
  const tb = toks(b);
  const inter = new Set([...ta].filter((x) => tb.has(x)));
  const union = new Set([...ta, ...tb]);
  const jac = union.size ? inter.size / union.size : 0.0;
  return Math.max(seq, jac);
}

function corpus(limit: number): Array<Record<string, any>> {
  const sql = `
    WITH e AS (SELECT 'episodic' tier,id::text id,COALESCE(happened_at::text,NOW()::text) ts,TRIM(COALESCE(summary,'')||' '||COALESCE(details,'')) body FROM cortana_memory_episodic WHERE active=TRUE ORDER BY happened_at DESC NULLS LAST LIMIT ${limit}),
         s AS (SELECT 'semantic' tier,id::text id,COALESCE(last_seen_at::text,first_seen_at::text,NOW()::text) ts,TRIM(COALESCE(subject,'')||' '||COALESCE(predicate,'')||' '||COALESCE(object_value,'')) body FROM cortana_memory_semantic WHERE active=TRUE ORDER BY last_seen_at DESC NULLS LAST LIMIT ${limit}),
         p AS (SELECT 'procedural' tier,id::text id,COALESCE(updated_at::text,created_at::text,NOW()::text) ts,TRIM(COALESCE(workflow_name,'')||' '||COALESCE(trigger_context,'')||' '||COALESCE(expected_outcome,'')) body FROM cortana_memory_procedural WHERE deprecated=FALSE ORDER BY updated_at DESC NULLS LAST LIMIT ${limit})
    SELECT * FROM (SELECT * FROM e UNION ALL SELECT * FROM s UNION ALL SELECT * FROM p) x WHERE COALESCE(body,'')<>'' ORDER BY ts DESC LIMIT ${limit * 2}
  `;
  try {
    return fetchJson(sql);
  } catch {
    return [];
  }
}

function scoreActionability(text: string): number {
  const t = ` ${text.toLowerCase()} `;
  const tokens = toks(t);
  let hits = 0;
  for (const w of ACTION) {
    if (tokens.has(w) || t.includes(` ${w} `)) hits += 1;
  }
  const hasVerb = /\b(do|build|send|review|fix|create|schedule|call|ship|track|improve)\b/.test(t);
  const hasTime = /\b(today|tomorrow|week|month|by\s+\w+day|\d{1,2}:\d{2})\b/.test(t);
  const score = 0.25 + 0.12 * hits + (hasVerb ? 0.15 : 0) + (hasTime ? 0.15 : 0);
  return Math.round(Math.min(1.0, score) * 1000) / 1000;
}

function scoreShelf(text: string): number {
  const t = text.toLowerCase();
  let long = 0;
  let short = 0;
  for (const w of LONG) if (t.includes(w)) long += 1;
  for (const w of SHORT) if (t.includes(w)) short += 1;
  if (long === 0 && short === 0) return 0.55;
  const score = 0.5 + 0.1 * long - 0.12 * short;
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
}

function contradiction(neu: string, old: string): [boolean, string] {
  const ov = new Set([...toks(neu)].filter((x) => toks(old).has(x)));
  if (ov.size < 3) return [false, "low overlap"];
  const nneg = NEG.some((w) => ` ${neu.toLowerCase()} `.includes(w));
  const oneg = NEG.some((w) => ` ${old.toLowerCase()} `.includes(w));
  if (nneg !== oneg) return [true, "polarity flip with shared anchors"];
  return [false, "none"];
}

function evaluate(c: Candidate, limit = 300): Record<string, any> {
  const mem = corpus(limit);
  const scored: Array<[number, Record<string, any>]> = [];
  for (const r of mem) {
    const s = sim(c.text, String(r.body ?? ""));
    if (s >= 0.35) scored.push([s, r]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const top = scored.slice(0, 8);
  const rec = scored.filter((x) => x[0] >= 0.72).length;
  const novelty = Math.round(Math.max(0, 1 - (top.length ? top[0][0] : 0)) * 1000) / 1000;
  const recurrence = Math.round(Math.max(0, 1 - Math.min(rec, 8) / 8) * 1000) / 1000;
  const action = scoreActionability(c.text);
  const shelf = scoreShelf(c.text);
  const weighted = Math.round((novelty * 0.35 + action * 0.25 + recurrence * 0.2 + shelf * 0.2) * 1000) / 1000;
  const verdict = weighted >= 0.68 && novelty >= 0.4 ? "promote" : weighted >= 0.45 ? "hold" : "archive";
  const supers: Array<Record<string, any>> = [];
  const now = c.timestamp ?? new Date().toISOString();
  for (const [s, r] of top) {
    const [ok, why] = contradiction(c.text, String(r.body ?? ""));
    if (ok) {
      supers.push({
        tier: r.tier,
        id: r.id,
        similarity: Math.round(s * 1000) / 1000,
        demote_recommended: true,
        reason: why,
        new_memory_timestamp: now,
      });
    }
  }
  const reasons: string[] = [];
  if (novelty < 0.35) reasons.push("low novelty");
  if (action < 0.35) reasons.push("low actionability");
  if (shelf < 0.35) reasons.push("short shelf-life");
  return {
    verdict,
    scores: { novelty, actionability: action, recurrence, shelf_life: shelf, weighted },
    recurrence_count: rec,
    matched_examples: top.map(([s, r]) => ({
      tier: r.tier,
      id: r.id,
      similarity: Math.round(s * 1000) / 1000,
      text_preview: String(r.body ?? "").slice(0, 180),
    })),
    supersession_flags: supers,
    reasons,
  };
}

function sqlEscape(text: string): string {
  return text.replace(/'/g, "''");
}

function logEvent(c: Candidate, res: Record<string, any>): void {
  const payload = JSON.stringify({
    memory_text: c.text.slice(0, 500),
    source_type: c.source_type,
    source_ref: c.source_ref,
    result: res,
  }).replace(/'/g, "''");
  const msg = `Evaluated memory candidate: ${res.verdict}`.replace(/'/g, "''");
  runPsql(
    `INSERT INTO cortana_events (event_type,source,severity,message,metadata) VALUES ('memory_quality_gate','memory_quality_gate.ts','info','${msg}','${payload}'::jsonb);`
  );
}

function printHelp(): void {
  const text = `usage: memory_quality_gate.ts [-h] [--text TEXT] [--text-file TEXT_FILE] [--source-type SOURCE_TYPE] [--source-ref SOURCE_REF] [--timestamp TIMESTAMP] [--corpus-limit CORPUS_LIMIT] [--log-event] [--dry-run]\n\nScore memory quality and return consolidation verdict\n\noptions:\n  -h, --help            show this help message and exit\n  --text TEXT\n  --text-file TEXT_FILE\n  --source-type SOURCE_TYPE\n  --source-ref SOURCE_REF\n  --timestamp TIMESTAMP\n  --corpus-limit CORPUS_LIMIT\n  --log-event\n  --dry-run`;
  console.log(text);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let text = "";
  let textFile: string | null = null;
  let sourceType = "manual";
  let sourceRef: string | null = null;
  let timestamp: string | null = null;
  let corpusLimit = 300;
  let logEventFlag = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "--text" && next) {
      text = next;
      i += 1;
    } else if (arg === "--text-file" && next) {
      textFile = next;
      i += 1;
    } else if (arg === "--source-type" && next) {
      sourceType = next;
      i += 1;
    } else if (arg === "--source-ref" && next) {
      sourceRef = next;
      i += 1;
    } else if (arg === "--timestamp" && next) {
      timestamp = next;
      i += 1;
    } else if (arg === "--corpus-limit" && next) {
      corpusLimit = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--log-event") {
      logEventFlag = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  if (textFile) {
    text = fs.readFileSync(textFile, "utf8").trim();
  }

  if (!text) {
    console.error("Provide --text or --text-file");
    process.exit(1);
  }

  const c: Candidate = { text, source_type: sourceType, source_ref: sourceRef, timestamp };
  const res = evaluate(c, corpusLimit);
  if (logEventFlag && !dryRun) logEvent(c, res);
  console.log(JSON.stringify(res, null, 2));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
