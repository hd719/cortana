#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { resolveRepoPath } from "../lib/paths.js";
import { query } from "../lib/db.js";

const WORKSPACE = resolveRepoPath();
const PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql";
const DB_NAME = "cortana";
const SESSIONS_GLOB = path.join(process.env.HOME || "", ".openclaw", "agents", "main", "sessions", "*.jsonl");
const DAILY_NOTES_DIR = path.join(WORKSPACE, "memory");
const EMBED_SCRIPT = path.join(WORKSPACE, "tools", "embeddings", "embed.py");
const EMBED_BIN = path.join(WORKSPACE, "tools", "embeddings", "embed");

const DEFAULT_MODEL = "phi3:mini";
const EMBED_MODEL = "BAAI/bge-small-en-v1.5";
const VALID_TYPES = new Set(["preference", "decision", "fact", "event"]);

type Candidate = {
  source_ref: string;
  source_kind: string;
  happened_at: Date;
  text: string;
};

type Insight = {
  fact_type: string;
  subject: string;
  predicate: string;
  object_value: string;
  confidence: number;
  importance: number;
  tags: string[];
  rationale: string;
};

function sh(cmd: string[], timeout = 120000): ReturnType<typeof spawnSync> {
  return spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout });
}

function psql(sql: string, capture = false): string {
  const proc = sh([PSQL_BIN, DB_NAME, "-q", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], 180000);
  if (proc.status !== 0) {
    throw new Error((proc.stderr || "").trim() || "psql failed");
  }
  return capture ? (proc.stdout || "").trim() : "";
}

function q(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function md5s(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

function vecSql(vec: number[]): string {
  return `'[${vec.map((x) => x.toFixed(8)).join(",")}]'::vector`;
}

function ensureSchema(): void {
  const sql = `
ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS embedding_local VECTOR(384),
  ADD COLUMN IF NOT EXISTS embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS extraction_source TEXT,
  ADD COLUMN IF NOT EXISTS superseded_by BIGINT,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supersedes_id BIGINT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='cortana_memory_semantic_fact_type_check'
  ) THEN
    ALTER TABLE cortana_memory_semantic DROP CONSTRAINT cortana_memory_semantic_fact_type_check;
  END IF;

  ALTER TABLE cortana_memory_semantic
    ADD CONSTRAINT cortana_memory_semantic_fact_type_check
    CHECK (fact_type = ANY (ARRAY['fact','preference','event','system_rule','decision','rule','relationship']));
END $$;

CREATE INDEX IF NOT EXISTS idx_memory_semantic_embedding_local_hnsw
  ON cortana_memory_semantic USING hnsw (embedding_local vector_cosine_ops)
  WHERE embedding_local IS NOT NULL;
`;
  psql(sql);
}

function parseSessionCandidates(sinceHours: number): Candidate[] {
  const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
  const dir = path.dirname(SESSIONS_GLOB);
  const matcher = new RegExp(`^${path.basename(SESSIONS_GLOB).replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
  const out: Candidate[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  for (const name of entries) {
    const p = path.join(dir, name);
    if (name.includes(".deleted.")) continue;
    if (!matcher.test(name)) continue;
    let mtime: number;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) continue;

    const raw = fs.readFileSync(p, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: any;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (obj.type !== "message") continue;
      const msg = obj.message ?? {};
      if (msg.role !== "user") continue;
      const parts: string[] = [];
      for (const chunk of msg.content ?? []) {
        if (chunk && typeof chunk === "object" && chunk.type === "text" && typeof chunk.text === "string") {
          parts.push(chunk.text.trim());
        }
      }
      const text = parts.filter(Boolean).join(" ").trim();
      if (text.length < 16) continue;

      let happenedAt = new Date(mtime);
      const ts = obj.timestamp;
      if (typeof ts === "string") {
        const dt = new Date(ts.replace("Z", "+00:00"));
        if (!Number.isNaN(dt.getTime())) happenedAt = dt;
      }

      out.push({ source_ref: p, source_kind: "session", happened_at: happenedAt, text });
    }
  }
  return out;
}

function parseDailyNoteCandidates(sinceHours: number): Candidate[] {
  const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
  const out: Candidate[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(DAILY_NOTES_DIR);
  } catch {
    return [];
  }
  for (const name of entries.sort()) {
    if (!name.match(/^20\d{2}.*\.md$/)) continue;
    const p = path.join(DAILY_NOTES_DIR, name);
    let mtime: number;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) continue;

    const text = fs.readFileSync(p, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#")) continue;
      if (line.startsWith("- ")) line = line.slice(2).trim();
      if (line.length < 24) continue;
      out.push({ source_ref: p, source_kind: "daily-notes", happened_at: new Date(mtime), text: line });
    }
  }
  return out;
}

function loadCandidates(source: string, sinceHours: number): Candidate[] {
  if (source === "session") return parseSessionCandidates(sinceHours);
  if (source === "daily-notes") return parseDailyNoteCandidates(sinceHours);
  throw new Error(`Unsupported source: ${source}`);
}

async function callOllama(prompt: string, model = DEFAULT_MODEL): Promise<Record<string, any>> {
  const payload = { model, prompt, stream: false, format: "json", options: { temperature: 0.1 } };
  const res = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "ollama call failed");
  }
  const wrapped = (await res.json()) as any;
  const response = String(wrapped.response ?? "{}").trim();
  try {
    return JSON.parse(response);
  } catch {
    const start = response.indexOf("{");
    const end = response.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(response.slice(start, end + 1));
    }
    return { classification: "skip" };
  }
}

async function classifyCandidate(c: Candidate, model: string): Promise<Insight | null> {
  const prompt = `
You classify one user statement for memory promotion.
Return strict JSON only with keys:
- classification: one of preference|decision|fact|event|skip
- subject: short lowercase subject (default hamel)
- predicate: short normalized predicate (e.g. prefers, decided, works_as, plans)
- object_value: concise atomic statement value
- confidence: number 0..1
- importance: number 0..1
- tags: array of <=6 lowercase tags
- rationale: <=20 words

Rules:
- Use skip for chit-chat, one-off procedural commands, or weak/noisy lines.
- Keep object_value factual and concise.
- No markdown, no prose, valid JSON only.

Source: ${c.source_kind}
Statement: ${c.text}
`.trim();

  const parsed = await callOllama(prompt, model);
  const cls = String(parsed.classification ?? "skip").trim().toLowerCase();
  if (!VALID_TYPES.has(cls)) return null;

  const objectValue = String(parsed.object_value ?? "").split(/\s+/).join(" ").trim();
  if (objectValue.length < 8) return null;

  const subject = String(parsed.subject ?? "hamel").trim().toLowerCase() || "hamel";
  const predicate = String(parsed.predicate ?? "stated").trim().toLowerCase() || "stated";
  const confidence = clamp(Number(parsed.confidence ?? 0.7), 0.0, 1.0);
  const importance = clamp(Number(parsed.importance ?? 0.6), 0.0, 1.0);
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((t: any) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 6)
    : [];
  const rationale = String(parsed.rationale ?? "").trim().slice(0, 200);

  return {
    fact_type: cls,
    subject,
    predicate,
    object_value: objectValue,
    confidence,
    importance,
    tags,
    rationale,
  };
}

function embed(text: string): number[] {
  const cmd = fs.existsSync(EMBED_BIN)
    ? [EMBED_BIN, "embed", "--text", text]
    : ["python3", EMBED_SCRIPT, "embed", "--text", text];
  const proc = sh(cmd, 180000);
  if (proc.status !== 0) {
    throw new Error((proc.stderr || "").trim() || (proc.stdout || "").trim() || "embedding failed");
  }
  const payload = JSON.parse(proc.stdout || "{}");
  const vectors = payload.vectors || [];
  if (!vectors.length) throw new Error("no embedding returned");
  return (vectors[0] as any[]).map((x) => Number(x));
}

function topNeighbor(vec: number[]): [number, string, string, string, number] | null {
  const sql = `
SELECT id, fact_type, predicate, object_value,
       1 - (embedding_local <=> ${vecSql(vec)}) AS similarity
FROM cortana_memory_semantic
WHERE active = TRUE
  AND embedding_local IS NOT NULL
ORDER BY embedding_local <=> ${vecSql(vec)}
LIMIT 1;
`;
  const row = psql(sql, true);
  if (!row) return null;
  const [rid, factType, predicate, objectValue, sim] = row.split("|", 5);
  return [Number(rid), factType, predicate, objectValue, Number(sim)];
}

function isSemanticDuplicate(insight: Insight, neighbor: [number, string, string, string, number] | null): [boolean, number, number | null] {
  if (!neighbor) return [false, 0.0, null];
  const [rid, factType, predicate, objectValue, sim] = neighbor;

  if (sim >= 0.94 && factType === insight.fact_type && predicate === insight.predicate) {
    return [true, sim, rid];
  }
  if (sim >= 0.975) {
    return [true, sim, rid];
  }
  const a = new Set(insight.object_value.toLowerCase().split(/\s+/));
  const b = new Set(objectValue.toLowerCase().split(/\s+/));
  const inter = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  const overlap = union.size ? inter.size / union.size : 0.0;
  if (sim >= 0.92 && overlap >= 0.75) {
    return [true, sim, rid];
  }

  return [false, sim, rid];
}

function insertInsight(insight: Insight, candidate: Candidate, vec: number[], dryRun: boolean): Record<string, any> {
  const fingerprint = md5s(
    `insight|${insight.fact_type}|${insight.subject}|${insight.predicate}|${insight.object_value}`
  );
  const metadata = {
    pipeline: "conversation-insight-promotion",
    source_kind: candidate.source_kind,
    tags: insight.tags,
    importance: insight.importance,
    classifier_rationale: insight.rationale,
    raw_excerpt: candidate.text.slice(0, 500),
    happened_at: candidate.happened_at.toISOString(),
  };

  if (dryRun) {
    return {
      action: "would_insert",
      type: insight.fact_type,
      predicate: insight.predicate,
      object_value: insight.object_value,
      source_ref: candidate.source_ref,
    };
  }

  const sql = `
INSERT INTO cortana_memory_semantic (
  fact_type, subject, predicate, object_value,
  confidence, trust, stability,
  first_seen_at, last_seen_at,
  source_type, source_ref, fingerprint,
  metadata, embedding_local, embedding_model, extraction_source
) VALUES (
  ${q(insight.fact_type)},
  ${q(insight.subject)},
  ${q(insight.predicate)},
  ${q(insight.object_value)},
  ${insight.confidence.toFixed(3)},
  ${Math.max(0.6, insight.confidence).toFixed(3)},
  ${Math.max(0.45, insight.importance).toFixed(3)},
  ${q(candidate.happened_at.toISOString())},
  NOW(),
  'insight_promotion',
  ${q(candidate.source_ref)},
  ${q(fingerprint)},
  ${q(JSON.stringify(metadata))}::jsonb,
  ${vecSql(vec)},
  ${q(EMBED_MODEL)},
  ${q(candidate.source_kind)}
)
ON CONFLICT (fact_type, subject, predicate, object_value)
DO UPDATE SET
  last_seen_at = NOW(),
  confidence = GREATEST(cortana_memory_semantic.confidence, EXCLUDED.confidence),
  metadata = cortana_memory_semantic.metadata || EXCLUDED.metadata
RETURNING id;
`;
  const mid = Number(psql(sql, true));
  return {
    action: "inserted",
    id: mid,
    type: insight.fact_type,
    predicate: insight.predicate,
    object_value: insight.object_value,
    source_ref: candidate.source_ref,
  };
}

async function cmdScan(source: string, sinceHours: number, model: string, dryRun: boolean): Promise<void> {
  ensureSchema();
  const candidates = loadCandidates(source, sinceHours);

  const results: Record<string, any>[] = [];
  const counts = { promoted: 0, skip_classification: 0, skip_duplicate: 0, errors: 0 };

  for (const c of candidates) {
    try {
      const insight = await classifyCandidate(c, model);
      if (!insight) {
        counts.skip_classification += 1;
        continue;
      }

      const vec = embed(`${insight.fact_type} | ${insight.subject} | ${insight.predicate} | ${insight.object_value}`);
      const [duplicate, similarity, existingId] = isSemanticDuplicate(insight, topNeighbor(vec));
      if (duplicate) {
        counts.skip_duplicate += 1;
        results.push({
          action: "skip_duplicate",
          existing_id: existingId,
          similarity: Number(similarity.toFixed(4)),
          type: insight.fact_type,
          object_value: insight.object_value,
        });
        continue;
      }

      const rec = insertInsight(insight, c, vec, dryRun);
      counts.promoted += 1;
      results.push(rec);
    } catch (e) {
      counts.errors += 1;
      results.push({ action: "error", source_ref: c.source_ref, error: String(e) });
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "scan",
        source,
        since_hours: sinceHours,
        candidates: candidates.length,
        summary: counts,
        results,
      },
      null,
      2
    )
  );
}

function cmdStats(days: number): void {
  const sql = `
SELECT to_char(date_trunc('day', first_seen_at), 'YYYY-MM-DD') AS day,
       fact_type,
       COUNT(*)
FROM cortana_memory_semantic
WHERE source_type = 'insight_promotion'
  AND first_seen_at >= NOW() - INTERVAL '${Math.trunc(days)} days'
GROUP BY 1,2
ORDER BY 1 DESC, 2;
`;
  const rows = psql(sql, true).split(/\r?\n/);
  const data: Record<string, any>[] = [];
  for (const row of rows) {
    if (!row) continue;
    const [day, factType, count] = row.split("|", 3);
    data.push({ day, type: factType, count: Number(count) });
  }

  const totalsSql = `
SELECT fact_type, COUNT(*)
FROM cortana_memory_semantic
WHERE source_type = 'insight_promotion'
  AND first_seen_at >= NOW() - INTERVAL '${Math.trunc(days)} days'
GROUP BY fact_type
ORDER BY COUNT(*) DESC;
`;
  const totalsRows = psql(totalsSql, true).split(/\r?\n/);
  const totals: Record<string, number> = {};
  for (const row of totalsRows) {
    if (!row) continue;
    const [t, c] = row.split("|", 2);
    totals[t] = Number(c);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "stats",
        days,
        totals_by_type: totals,
        series: data,
      },
      null,
      2
    )
  );
}

function printHelp(): void {
  const text = `usage: promote_insights.ts [-h] {scan,stats} ...\n\nPromote conversation insights into semantic memory\n\noptions:\n  -h, --help  show this help message and exit`;
  console.log(text);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    printHelp();
    if (argv.length === 0) process.exit(2);
    return;
  }

  const cmd = argv[0];
  if (cmd === "scan") {
    let source: string | null = null;
    let sinceHours = 24;
    let model = DEFAULT_MODEL;
    let dryRun = false;
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      const next = argv[i + 1];
      if (arg === "--source" && next) {
        source = next;
        i += 1;
      } else if (arg === "--since-hours" && next) {
        sinceHours = Number.parseInt(next, 10);
        i += 1;
      } else if (arg === "--model" && next) {
        model = next;
        i += 1;
      } else if (arg === "--dry-run") {
        dryRun = true;
      } else if (arg === "-h" || arg === "--help") {
        printHelp();
        return;
      } else if (arg.startsWith("-")) {
        console.error(`Unknown argument: ${arg}`);
        printHelp();
        process.exit(2);
      }
    }
    if (!source || (source !== "session" && source !== "daily-notes")) {
      console.error("--source must be session or daily-notes");
      process.exit(2);
    }
    await cmdScan(source, sinceHours, model, dryRun);
    return;
  }

  if (cmd === "stats") {
    let days = 30;
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      const next = argv[i + 1];
      if (arg === "--days" && next) {
        days = Number.parseInt(next, 10);
        i += 1;
      } else if (arg === "-h" || arg === "--help") {
        printHelp();
        return;
      } else if (arg.startsWith("-")) {
        console.error(`Unknown argument: ${arg}`);
        printHelp();
        process.exit(2);
      }
    }
    cmdStats(days);
    return;
  }

  console.error("Unknown command");
  process.exit(2);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
