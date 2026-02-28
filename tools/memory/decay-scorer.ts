#!/usr/bin/env npx tsx

import fs from "fs";
import os from "os";
import path from "path";

const HALF_LIVES: Record<string, number> = {
  fact: 365,
  task: 30,
  emotional: 60,
  episodic: 14,
  preference: 730,
  decision: 180,
};

const DB_PATH = path.join(os.homedir(), ".openclaw", "memory", "lancedb");
const TABLE_NAME = "memories";
const EMBED_MODEL = "text-embedding-3-small";
const OPENCLAW_CONFIG = path.join(os.homedir(), ".openclaw", "openclaw.json");

function readApiKey(): string {
  const raw = fs.readFileSync(OPENCLAW_CONFIG, "utf8");
  const cfg = JSON.parse(raw) as any;
  const key = cfg?.plugins?.entries?.["memory-lancedb"]?.config?.embedding?.apiKey;
  if (!key) {
    throw new Error(
      "OpenAI API key not found at plugins.entries.memory-lancedb.config.embedding.apiKey"
    );
  }
  return String(key);
}

async function embedQuery(query: string, apiKey: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: query }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "OpenAI embeddings request failed");
  }
  const data = (await res.json()) as any;
  return Array.from(data.data?.[0]?.embedding ?? []);
}

async function requireLanceDb(): Promise<any> {
  try {
    const mod: any = await import("lancedb");
    return mod?.default ?? mod;
  } catch (err) {
    const msg = "Missing dependency: lancedb. Install with: python3 -m pip install lancedb";
    throw new Error(msg);
  }
}

function toEpoch(value: any): number {
  if (value === null || value === undefined) return Date.now();
  if (typeof value === "number") {
    return value > 1_000_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  if (typeof value === "string") {
    const v = value.trim();
    const n = Number(v);
    if (!Number.isNaN(n)) return toEpoch(n);
    const dt = new Date(v.replace("Z", "+00:00"));
    if (!Number.isNaN(dt.getTime())) return dt.getTime();
    return Date.now();
  }
  return Date.now();
}

function daysOld(createdAt: any): number {
  const nowMs = Date.now();
  const createdMs = toEpoch(createdAt);
  return Math.max((nowMs - createdMs) / (1000 * 60 * 60 * 24), 0.0);
}

function safeFloat(v: any, def = 0.0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function computeScore(row: Record<string, any>): Record<string, any> {
  const similarity = safeFloat(row.similarity, 0.0);
  const category = String(row.category ?? "fact").toLowerCase();
  const halfLife = HALF_LIVES[category] ?? HALF_LIVES.fact;
  const days = daysOld(row.createdAt ?? row.created_at);
  const recencyScore = 2 ** -(days / halfLife);

  const accessCount = Math.trunc(safeFloat(row.access_count, 0.0));
  const utilityScore = Math.log10(accessCount + 1);

  const score = 0.5 * similarity + 0.3 * recencyScore + 0.2 * utilityScore;

  return {
    ...row,
    days_old: Math.round(days * 1000) / 1000,
    half_life: halfLife,
    recency_score: recencyScore,
    utility_score: utilityScore,
    decay_adjusted_score: score,
  };
}

async function searchWithDecay(query: string, topK = 5, candidateK?: number): Promise<Record<string, any>[]> {
  const apiKey = readApiKey();
  const queryVector = await embedQuery(query, apiKey);

  const lancedb = await requireLanceDb();
  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable(TABLE_NAME);

  const candidates = candidateK ?? Math.max(topK * 5, 25);
  const searchBuilder = typeof table.vectorSearch === "function" ? table.vectorSearch(queryVector) : table.search(queryVector);
  const runner = searchBuilder.limit(candidates);

  let raw: any[] = [];
  if (typeof runner.toArray === "function") {
    raw = await runner.toArray();
  } else if (typeof runner.toList === "function") {
    raw = await runner.toList();
  } else if (typeof runner.toJSON === "function") {
    raw = await runner.toJSON();
  } else if (typeof runner.toRecords === "function") {
    raw = await runner.toRecords();
  } else if (Symbol.asyncIterator in runner) {
    for await (const row of runner as AsyncIterable<any>) {
      raw.push(row);
    }
  }

  const scored: Record<string, any>[] = [];
  for (const row of raw) {
    const distance = safeFloat(row?._distance, 0.0);
    const similarity = 1.0 / (1.0 + distance);
    const item = { ...(row as Record<string, any>), similarity };
    scored.push(computeScore(item));
  }

  scored.sort((a, b) => (b.decay_adjusted_score ?? 0) - (a.decay_adjusted_score ?? 0));
  return scored.slice(0, topK);
}

function printHelp(): void {
  const text = `usage: decay-scorer.ts [-h] --query QUERY [--top-k TOP_K] [--candidate-k CANDIDATE_K]\n\nDecay-adjusted memory search scorer\n\noptions:\n  -h, --help            show this help message and exit\n  --query QUERY         Search query\n  --top-k TOP_K         Number of results to return\n  --candidate-k CANDIDATE_K\n                        Candidate pool size before re-ranking (default: max(top_k*5, 25))`;
  console.log(text);
}

function parseArgs(argv: string[]): { query: string | null; topK: number; candidateK: number | null } {
  const args = { query: null as string | null, topK: 5, candidateK: null as number | null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "--query" && next) {
      args.query = next;
      i += 1;
    } else if (arg === "--top-k" && next) {
      args.topK = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--candidate-k" && next) {
      args.candidateK = Number.parseInt(next, 10);
      i += 1;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error("--query is required");
    printHelp();
    process.exit(2);
  }
  const results = await searchWithDecay(args.query, args.topK, args.candidateK ?? undefined);
  console.log(JSON.stringify({ query: args.query, top_k: args.topK, results }, null, 2));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
