#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { resolveRepoPath } from "../lib/paths.js";

const WORKSPACE = resolveRepoPath();
const PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql";
const DB_NAME = "cortana";
const PROMPT_FILE = path.join(WORKSPACE, "tools", "memory", "prompts", "fact_extraction.txt");
const EMBED_SCRIPT = path.join(WORKSPACE, "tools", "embeddings", "embed.py");
const EMBED_BIN = path.join(WORKSPACE, "tools", "embeddings", "embed");
const SESSIONS_GLOB = path.join("~", ".openclaw", "agents", "main", "sessions", "*.jsonl");

const VALID_TYPES = new Set(["fact", "preference", "event", "system_rule"]);

type AtomicFact = {
  fact_type: string;
  content: string;
  tags: string[];
  people: string[];
  projects: string[];
  importance: number;
  confidence: number;
  supersedes_id: number | null;
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

function ensureSchema(): void {
  const sql = `
ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS fact_type TEXT,
  ADD COLUMN IF NOT EXISTS superseded_by BIGINT,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supersedes_id BIGINT,
  ADD COLUMN IF NOT EXISTS extraction_source TEXT,
  ADD COLUMN IF NOT EXISTS embedding_local VECTOR(384);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='cortana_memory_semantic_superseded_by_fkey'
  ) THEN
    ALTER TABLE cortana_memory_semantic
      ADD CONSTRAINT cortana_memory_semantic_superseded_by_fkey
      FOREIGN KEY (superseded_by) REFERENCES cortana_memory_semantic(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='cortana_memory_semantic_supersedes_id_fkey'
  ) THEN
    ALTER TABLE cortana_memory_semantic
      ADD CONSTRAINT cortana_memory_semantic_supersedes_id_fkey
      FOREIGN KEY (supersedes_id) REFERENCES cortana_memory_semantic(id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='cortana_memory_semantic_fact_type_check'
  ) THEN
    ALTER TABLE cortana_memory_semantic DROP CONSTRAINT cortana_memory_semantic_fact_type_check;
  END IF;

  ALTER TABLE cortana_memory_semantic
    ALTER COLUMN fact_type SET DEFAULT 'fact';

  UPDATE cortana_memory_semantic
  SET fact_type = 'fact'
  WHERE fact_type IS NULL;

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

function loadPrompt(): string {
  if (!fs.existsSync(PROMPT_FILE)) {
    throw new Error(`Missing prompt template: ${PROMPT_FILE}`);
  }
  return fs.readFileSync(PROMPT_FILE, "utf8");
}

function parseJsonlTranscript(filePath: string): string {
  const lines: string[] = [];
  const raw = fs.readFileSync(filePath, "utf8");
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
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;
    const textParts: string[] = [];
    for (const chunk of msg.content ?? []) {
      if (chunk && typeof chunk === "object" && chunk.type === "text" && typeof chunk.text === "string") {
        textParts.push(chunk.text);
      }
    }
    if (textParts.length) {
      lines.push(`${String(role).toUpperCase()}: ${textParts.join(" ").trim()}`);
    }
  }
  return lines.join("\n");
}

function readInput(inputPath: string): [string, string] {
  if (inputPath === "-") {
    return ["stdin", fs.readFileSync(0, "utf8")];
  }
  const p = path.resolve(inputPath);
  if (!fs.existsSync(p)) {
    throw new Error(inputPath);
  }
  if (p.endsWith(".jsonl")) {
    return [p, parseJsonlTranscript(p)];
  }
  return [p, fs.readFileSync(p, { encoding: "utf8", flag: "r" })];
}

function embed(text: string): number[] {
  const cmd = fs.existsSync(EMBED_BIN)
    ? [EMBED_BIN, "embed", "--text", text]
    : ["python3", EMBED_SCRIPT, "embed", "--text", text];
  const proc = sh(cmd, 120000);
  if (proc.status !== 0) {
    throw new Error((proc.stderr || "").trim() || (proc.stdout || "").trim() || "embedding failed");
  }
  const payload = JSON.parse(proc.stdout || "{}");
  const vectors = payload.vectors || [];
  if (!vectors.length) throw new Error("no embedding returned");
  return (vectors[0] as any[]).map((x) => Number(x));
}

function vecSql(vec: number[]): string {
  return `'[${vec.map((x) => x.toFixed(8)).join(",")}]'::vector`;
}

async function callOllama(prompt: string, model: string): Promise<Record<string, any>> {
  const payload = {
    model,
    prompt,
    stream: false,
    format: "json",
    options: { temperature: 0.1 },
  };

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
      try {
        return JSON.parse(response.slice(start, end + 1));
      } catch {
        return { facts: [] };
      }
    }
    return { facts: [] };
  }
}

function normalizeFact(raw: Record<string, any>): AtomicFact | null {
  try {
    const factType = String(raw.type ?? "").trim();
    const content = String(raw.content ?? "").split(/\s+/).join(" ").trim();
    const tags = Array.isArray(raw.tags) ? raw.tags.map((t: any) => String(t).trim()).filter(Boolean) : [];
    const people = Array.isArray(raw.people) ? raw.people.map((p: any) => String(p).trim()).filter(Boolean) : [];
    const projects = Array.isArray(raw.projects) ? raw.projects.map((p: any) => String(p).trim()).filter(Boolean) : [];
    const importance = Math.max(0.0, Math.min(1.0, Number(raw.importance ?? 0.5)));
    const confidence = Math.max(0.0, Math.min(1.0, Number(raw.confidence ?? 0.5)));

    if (!VALID_TYPES.has(factType)) return null;
    if (content.length < 8) return null;

    let supersedesId: number | null = null;
    if (raw.supersedes_id !== null && raw.supersedes_id !== undefined) {
      const v = Number.parseInt(String(raw.supersedes_id), 10);
      supersedesId = Number.isFinite(v) ? v : null;
    }

    return {
      fact_type: factType,
      content,
      tags: tags.slice(0, 12),
      people: people.slice(0, 12),
      projects: projects.slice(0, 12),
      importance,
      confidence,
      supersedes_id: supersedesId,
    };
  } catch {
    return null;
  }
}

function findNeighbors(vec: number[]): Array<[number, string, number]> {
  const sql = `
SELECT id, object_value, 1 - (embedding_local <=> ${vecSql(vec)}) AS similarity
FROM cortana_memory_semantic
WHERE active = TRUE
  AND embedding_local IS NOT NULL
  AND (1 - (embedding_local <=> ${vecSql(vec)})) >= 0.85
ORDER BY embedding_local <=> ${vecSql(vec)}
LIMIT 5;
`;
  const rows = psql(sql, true).split(/\r?\n/);
  const out: Array<[number, string, number]> = [];
  for (const row of rows) {
    if (!row) continue;
    const [rid, text, sim] = row.split("|", 3);
    out.push([Number(rid), text, Number(sim)]);
  }
  return out;
}

async function classifyMeaning(existing: string, neu: string, model: string): Promise<[boolean, boolean]> {
  const prompt =
    "Return only JSON {\"identical\":true|false,\"updated\":true|false}. " +
    "identical=true when both statements mean the same thing. " +
    "updated=true when B should supersede A (same subject, newer/corrected detail).\n" +
    `A: ${existing}\nB: ${neu}\n`;
  try {
    const parsed = await callOllama(prompt, model);
    return [Boolean(parsed.identical), Boolean(parsed.updated)];
  } catch {
    return [false, false];
  }
}

function insertFact(fact: AtomicFact, sourceRef: string, vec: number[], supersedesId: number | null, dryRun: boolean): Record<string, any> {
  const metadata = JSON.stringify({
    atomic_fact: true,
    importance: fact.importance,
    tags: fact.tags,
    people: fact.people,
    projects: fact.projects,
  });

  if (dryRun) {
    return { action: "would_insert", fact: fact.content, supersedes_id: supersedesId };
  }

  const sql = `
INSERT INTO cortana_memory_semantic (
  fact_type, subject, predicate, object_value,
  confidence, trust, stability,
  first_seen_at, last_seen_at,
  source_type, source_ref, fingerprint,
  metadata, embedding_local, embedding_model,
  extraction_source, supersedes_id
) VALUES (
  ${q(fact.fact_type)},
  'hamel',
  'stated',
  ${q(fact.content)},
  ${fact.confidence.toFixed(3)},
  ${Math.max(0.5, fact.confidence).toFixed(3)},
  ${Math.max(0.4, fact.importance).toFixed(3)},
  NOW(), NOW(),
  'atomic_extraction',
  ${q(sourceRef)},
  md5(${q(`${fact.fact_type}|${fact.content}`)}),
  ${q(metadata)}::jsonb,
  ${vecSql(vec)},
  'BAAI/bge-small-en-v1.5',
  ${q(sourceRef)},
  ${supersedesId ? String(supersedesId) : "NULL"}
)
ON CONFLICT (fact_type, subject, predicate, object_value)
DO UPDATE SET
  last_seen_at = NOW(),
  confidence = GREATEST(cortana_memory_semantic.confidence, EXCLUDED.confidence),
  metadata = cortana_memory_semantic.metadata || EXCLUDED.metadata
RETURNING id;
`;
  const newId = Number(psql(sql, true));

  if (supersedesId) {
    psql(
      `UPDATE cortana_memory_semantic SET active=FALSE, superseded_by=${newId}, superseded_at=NOW() WHERE id=${supersedesId};`
    );
  }

  return { action: "insert", id: newId, fact: fact.content, supersedes_id: supersedesId };
}

async function processText(text: string, sourceRef: string, model: string, dryRun: boolean): Promise<Record<string, any>[]> {
  const promptTemplate = loadPrompt();
  const prompt = promptTemplate.replace("{{TRANSCRIPT}}", text.slice(0, 18000)).replace("{{EXISTING_FACTS}}", "[]");
  const parsed = await callOllama(prompt, model);
  const factsRaw = typeof parsed === "object" && parsed ? parsed.facts ?? [] : [];

  const results: Record<string, any>[] = [];
  for (const item of factsRaw) {
    const fact = normalizeFact(item);
    if (!fact) continue;

    const vec = embed(fact.content);
    const neighbors = findNeighbors(vec);
    const best = neighbors.length ? neighbors[0] : null;

    if (best && best[2] > 0.95) {
      const [identical, updated] = await classifyMeaning(best[1], fact.content, model);
      if (identical) {
        results.push({ action: "skip_duplicate", existing_id: best[0], similarity: Number(best[2].toFixed(4)), fact: fact.content });
        continue;
      }
      if (updated) {
        results.push(insertFact(fact, sourceRef, vec, best[0], dryRun));
        continue;
      }
    }

    if (best && best[2] >= 0.85 && best[2] <= 0.95) {
      const [identical, updated] = await classifyMeaning(best[1], fact.content, model);
      if (identical) {
        results.push({ action: "skip_duplicate", existing_id: best[0], similarity: Number(best[2].toFixed(4)), fact: fact.content });
        continue;
      }
      if (updated) {
        results.push(insertFact(fact, sourceRef, vec, best[0], dryRun));
        continue;
      }
    }

    results.push(insertFact(fact, sourceRef, vec, null, dryRun));
  }

  return results;
}

async function cmdExtract(input: string, model: string, dryRun: boolean): Promise<void> {
  ensureSchema();
  const [sourceRef, text] = readInput(input);
  const results = await processText(text, sourceRef, model, dryRun);
  console.log(
    JSON.stringify({ ok: true, mode: "extract", source: sourceRef, count: results.length, results }, null, 2)
  );
}

function expandTilde(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(process.env.HOME || "", input.slice(2));
  }
  return input;
}

function recentSessionFiles(sinceHours: number): string[] {
  const globPath = expandTilde(SESSIONS_GLOB);
  const dir = path.dirname(globPath);
  const base = path.basename(globPath).replace(/\./g, "\\.").replace(/\*/g, ".*");
  const matcher = new RegExp(`^${base}$`);
  const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (name.includes(".deleted.")) continue;
    if (!matcher.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime >= cutoff) out.push(full);
    } catch {
      continue;
    }
  }
  return out.sort();
}

async function cmdBatch(sinceHours: number, model: string, dryRun: boolean): Promise<void> {
  ensureSchema();
  const files = recentSessionFiles(sinceHours);
  const allResults: Record<string, any>[] = [];
  for (const f of files) {
    const text = parseJsonlTranscript(f);
    if (!text.trim()) continue;
    allResults.push(...(await processText(text, f, model, dryRun)));
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "batch",
        since_hours: sinceHours,
        sessions: files.length,
        result_count: allResults.length,
        results: allResults,
      },
      null,
      2
    )
  );
}

function printHelp(): void {
  const text = `usage: extract_facts.ts [-h] {extract,batch} ...\n\nExtract atomic facts into cortana_memory_semantic\n\noptions:\n  -h, --help  show this help message and exit`;
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
  if (cmd === "extract") {
    let input: string | null = null;
    let dryRun = false;
    let model = "phi3:mini";
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      const next = argv[i + 1];
      if (arg === "--input" && next) {
        input = next;
        i += 1;
      } else if (arg === "--dry-run") {
        dryRun = true;
      } else if (arg === "--model" && next) {
        model = next;
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
    if (!input) {
      console.error("--input is required");
      process.exit(2);
    }
    await cmdExtract(input, model, dryRun);
    return;
  }

  if (cmd === "batch") {
    let sinceHours = 24;
    let dryRun = false;
    let model = "phi3:mini";
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      const next = argv[i + 1];
      if (arg === "--since-hours" && next) {
        sinceHours = Number.parseInt(next, 10);
        i += 1;
      } else if (arg === "--dry-run") {
        dryRun = true;
      } else if (arg === "--model" && next) {
        model = next;
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
    await cmdBatch(sinceHours, model, dryRun);
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
