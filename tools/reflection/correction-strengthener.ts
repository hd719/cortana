#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { query } from "../lib/db.js";
import { resolveRepoPath } from "../lib/paths.js";

type FeedbackRow = {
  id: number;
  feedback_type: string;
  context: string;
  lesson: string;
  timestamp: string;
};

type Proposal = {
  cluster_size: number;
  target_file: string;
  proposed_rule: string;
  supporting_feedback_ids: number[];
  feedback_types: string[];
  confidence: number;
};

const ROOT = resolveRepoPath();
const TARGET_FILES: Record<string, string> = {
  preference: "MEMORY.md",
  fact: "MEMORY.md",
  tone: "SOUL.md",
  behavior: "AGENTS.md",
  correction: "AGENTS.md",
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "where", "have", "has", "had",
  "was", "were", "are", "is", "be", "been", "being", "you", "your", "our", "not", "but", "can", "could",
  "should", "would", "will", "don", "did", "didnt", "dont", "about", "after", "before", "then", "than",
  "they", "them", "their", "always", "never", "must", "need", "using", "use", "used", "just", "more", "less",
]);

function runPsql(sql: string): string {
  return query(sql).trim();
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function fetchFeedback(windowDays?: number): FeedbackRow[] {
  let where = "WHERE LOWER(feedback_type) = 'correction'";
  if (windowDays) where += ` AND timestamp > NOW() - INTERVAL '${Math.trunc(windowDays)} days'`;

  let raw = runPsql(
    "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (" +
      "SELECT id, COALESCE(feedback_type,'') AS feedback_type, COALESCE(context,'') AS context, " +
      "COALESCE(lesson,'') AS lesson, timestamp::text AS timestamp " +
      `FROM cortana_feedback ${where} ORDER BY timestamp DESC` +
      ") t;"
  );

  let items = JSON.parse(raw || "[]") as Array<Record<string, any>>;
  if (!items.length) {
    raw = runPsql(
      "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (" +
        "SELECT id, COALESCE(feedback_type,'') AS feedback_type, COALESCE(context,'') AS context, " +
        "COALESCE(lesson,'') AS lesson, timestamp::text AS timestamp " +
        "FROM cortana_feedback ORDER BY timestamp DESC" +
        ") t;"
    );
    items = JSON.parse(raw || "[]") as Array<Record<string, any>>;
  }

  return items.map((i) => ({
    id: Number(i.id),
    feedback_type: String(i.feedback_type || "correction").toLowerCase(),
    context: String(i.context || ""),
    lesson: String(i.lesson || ""),
    timestamp: String(i.timestamp || ""),
  }));
}

function loadOpenAIKey(): string {
  const cfgPath = path.join(process.env.HOME || "", ".openclaw", "openclaw.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, any>;
  const key = cfg?.models?.providers?.openai?.apiKey || "";
  if (!key) throw new Error(`OpenAI apiKey missing in ${cfgPath}`);
  return key;
}

async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error(`embedding request failed: ${res.status}`);
  const body = (await res.json()) as Record<string, any>;
  const data = (body.data || []) as Array<Record<string, any>>;
  if (data.length !== texts.length) throw new Error(`embedding size mismatch: expected ${texts.length}, got ${data.length}`);
  return data.sort((a, b) => Number(a.index || 0) - Number(b.index || 0)).map((d) => d.embedding as number[]);
}

async function embedAll(texts: string[], apiKey: string, batchSize = 100): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    out.push(...(await embedBatch(texts.slice(i, i + batchSize), apiKey)));
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function clusterIndices(embeddings: number[][], threshold: number): number[][] {
  const n = embeddings.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  const find = (x: number): number => {
    let i = x;
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (cosine(embeddings[i], embeddings[j]) >= threshold) union(i, j);
    }
  }

  const groups: Record<string, number[]> = {};
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    if (!groups[r]) groups[r] = [];
    groups[r].push(i);
  }

  return Object.values(groups).sort((a, b) => b.length - a.length);
}

function keywords(rows: FeedbackRow[]): string[] {
  const text = rows.map((r) => `${r.context} ${r.lesson}`).join(" ").toLowerCase();
  const toks = (text.match(/[a-z][a-z0-9_-]{2,}/g) || []).filter((t) => !STOPWORDS.has(t));
  const counts = new Map<string, number>();
  for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
}

function targetFile(rows: FeedbackRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.feedback_type, (counts.get(r.feedback_type) || 0) + 1);
  const kind = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "correction";
  return TARGET_FILES[kind] || "AGENTS.md";
}

function ruleText(rows: FeedbackRow[]): string {
  const lessons = rows.map((r) => r.lesson.trim().replace(/\s+/g, " ")).filter(Boolean);
  if (lessons.length) {
    const counts = new Map<string, number>();
    for (const l of lessons) counts.set(l, (counts.get(l) || 0) + 1);
    let common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (common.length > 180) common = `${common.slice(0, 177)}...`;
    return `Strengthen this rule: ${common}`;
  }

  const kws = keywords(rows);
  if (kws.length) return `Strengthen policy around repeated issue pattern: ${kws.slice(0, 5).join(", ")}`;
  return "Strengthen policy around repeated correction pattern in recent feedback.";
}

function proposalConfidence(embeddings: number[][], idxs: number[]): number {
  if (idxs.length <= 1) return 0;
  const sims: number[] = [];
  for (let i = 0; i < idxs.length; i += 1) {
    for (let j = i + 1; j < idxs.length; j += 1) {
      sims.push(cosine(embeddings[idxs[i]], embeddings[idxs[j]]));
    }
  }
  const avg = sims.reduce((a, b) => a + b, 0) / Math.max(1, sims.length);
  const sizeBonus = Math.min(0.2, 0.03 * idxs.length);
  return Number(Math.min(0.99, avg + sizeBonus).toFixed(3));
}

function buildProposals(rows: FeedbackRow[], embeddings: number[][], threshold: number, minCluster: number): Proposal[] {
  const clusters = clusterIndices(embeddings, threshold);
  const proposals: Proposal[] = [];

  for (const idxs of clusters) {
    if (idxs.length < minCluster) continue;
    const clusterRows = idxs.map((i) => rows[i]);
    proposals.push({
      cluster_size: idxs.length,
      target_file: targetFile(clusterRows),
      proposed_rule: ruleText(clusterRows),
      supporting_feedback_ids: clusterRows.map((r) => r.id),
      feedback_types: [...new Set(clusterRows.map((r) => r.feedback_type))].sort(),
      confidence: proposalConfidence(embeddings, idxs),
    });
  }

  return proposals.sort((a, b) => (b.cluster_size - a.cluster_size) || (b.confidence - a.confidence));
}

function logProposals(proposals: Proposal[]): void {
  for (const p of proposals) {
    const context = JSON.stringify({
      source: "correction-strengthener",
      cluster_size: p.cluster_size,
      target_file: p.target_file,
      supporting_feedback_ids: p.supporting_feedback_ids,
      confidence: p.confidence,
    });
    runPsql(
      "INSERT INTO cortana_feedback (feedback_type, context, lesson, applied) VALUES " +
        `('correction', '${sqlEscape(context)}', '${sqlEscape(p.proposed_rule)}', FALSE);`
    );
  }
}

type Args = {
  similarityThreshold: number;
  minCluster: number;
  windowDays: number | undefined;
  logToDb: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    similarityThreshold: 0.82,
    minCluster: 3,
    windowDays: undefined,
    logToDb: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === "--similarity-threshold" && n) {
      args.similarityThreshold = Number.parseFloat(n);
      i += 1;
    } else if (a === "--min-cluster" && n) {
      args.minCluster = Number.parseInt(n, 10);
      i += 1;
    } else if (a === "--window-days" && n) {
      args.windowDays = Number.parseInt(n, 10);
      i += 1;
    } else if (a === "--log-to-db") {
      args.logToDb = true;
    } else if (a === "--json") {
      args.json = true;
    }
  }

  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const rows = fetchFeedback(args.windowDays);
  if (!rows.length) {
    console.log("No feedback rows found.");
    return 0;
  }

  const texts = rows.map((r) => `${r.feedback_type}\n${r.context}\n${r.lesson}`.trim());
  const apiKey = loadOpenAIKey();
  const embeddings = await embedAll(texts, apiKey);

  const proposals = buildProposals(rows, embeddings, args.similarityThreshold, args.minCluster);
  if (args.logToDb && proposals.length) logProposals(proposals);

  const output = {
    rows_analyzed: rows.length,
    similarity_threshold: args.similarityThreshold,
    min_cluster: args.minCluster,
    proposals_found: proposals.length,
    proposals: proposals.map((p) => ({
      cluster_size: p.cluster_size,
      target_file: p.target_file,
      proposed_rule: p.proposed_rule,
      supporting_feedback_ids: p.supporting_feedback_ids,
      feedback_types: p.feedback_types,
      confidence: p.confidence,
    })),
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`rows_analyzed=${output.rows_analyzed} proposals_found=${output.proposals_found}`);
    for (const p of output.proposals) {
      console.log(
        `- target=${p.target_file} cluster=${p.cluster_size} conf=${Number(p.confidence).toFixed(3)} ids=[${p.supporting_feedback_ids.join(", ")}]\n` +
          `  rule: ${p.proposed_rule}`
      );
    }
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((exc) => {
    const msg = exc instanceof Error ? exc.message : String(exc);
    console.error(`Error: ${msg}`);
    process.exit(1);
  });
