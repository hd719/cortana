#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { query } from "../lib/db.js";
import { resolveRepoPath } from "../lib/paths.js";

type FeedbackRow = {
  id: number;
  timestamp: string;
  feedback_type: string;
  context: string;
  lesson: string;
  applied: boolean;
};

const BASE_DIR = resolveRepoPath();
const EMBED_SCRIPT = path.join(BASE_DIR, "tools", "embeddings", "embed.py");
const EMBED_BIN = path.join(BASE_DIR, "tools", "embeddings", "embed");
const POLICY_FILES: Record<string, string> = {
  memory: path.join(BASE_DIR, "MEMORY.md"),
  agents: path.join(BASE_DIR, "AGENTS.md"),
  soul: path.join(BASE_DIR, "SOUL.md"),
};

const TARGET_FILE_BY_TYPE: Record<string, string> = {
  preference: "memory",
  fact: "memory",
  behavior: "agents",
  correction: "agents",
  tone: "soul",
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "where", "have", "has", "had",
  "was", "were", "are", "is", "be", "been", "being", "you", "your", "our", "not", "but", "can", "could",
  "should", "would", "will", "don", "did", "didnt", "dont", "about", "after", "before", "then", "than",
  "they", "them", "their", "always", "never", "must", "need", "using", "use", "used", "just", "more", "less",
  "there", "here", "what", "which", "while", "because", "also", "onto", "across", "through", "very",
]);

class VerifierError extends Error {}

function runPsql(sql: string): string {
  return query(sql).trim();
}

function fetchFeedback(windowDays?: number, limit?: number): FeedbackRow[] {
  let where = "";
  if (windowDays && windowDays > 0) where = `WHERE timestamp > NOW() - INTERVAL '${Math.trunc(windowDays)} days'`;
  const lim = limit && limit > 0 ? `LIMIT ${Math.trunc(limit)}` : "";

  const sql =
    "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (" +
    "SELECT id, timestamp::text AS timestamp, COALESCE(feedback_type,'') AS feedback_type, " +
    "COALESCE(context,'') AS context, COALESCE(lesson,'') AS lesson, COALESCE(applied, false) AS applied " +
    `FROM cortana_feedback ${where} ORDER BY timestamp ASC ${lim}` +
    ") t;";

  const rows = JSON.parse(runPsql(sql) || "[]") as Array<Record<string, any>>;
  return rows.map((r) => ({
    id: Number(r.id),
    timestamp: String(r.timestamp || ""),
    feedback_type: String(r.feedback_type || "").toLowerCase() || "correction",
    context: String(r.context || ""),
    lesson: String(r.lesson || ""),
    applied: Boolean(r.applied),
  }));
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

function embedTexts(texts: string[]): number[][] {
  let proc;
  if (fs.existsSync(EMBED_SCRIPT)) {
    const venvPython = path.join(BASE_DIR, "tools", "embeddings", ".venv", "bin", "python");
    const pythonBin = fs.existsSync(venvPython) ? venvPython : process.execPath;
    proc = spawnSync(pythonBin, [EMBED_SCRIPT, "embed", "--stdin"], {
      input: JSON.stringify(texts),
      encoding: "utf8",
    });
  } else if (fs.existsSync(path.join(BASE_DIR, "tools", "embeddings", "embed.ts"))) {
    proc = spawnSync("npx", ["tsx", path.join(BASE_DIR, "tools", "embeddings", "embed.ts"), "embed", "--stdin"], {
      input: JSON.stringify(texts),
      encoding: "utf8",
    });
  } else if (fs.existsSync(EMBED_BIN)) {
    proc = spawnSync(EMBED_BIN, ["embed", "--stdin"], {
      input: JSON.stringify(texts),
      encoding: "utf8",
    });
  } else {
    throw new VerifierError(`Embedding script missing: ${EMBED_SCRIPT}`);
  }
  if (proc.status !== 0) throw new VerifierError((proc.stderr || "embedding failed").trim());

  const payload = JSON.parse(proc.stdout || "{}") as Record<string, any>;
  const vectors = (payload.vectors || []) as number[][];
  if (vectors.length !== texts.length) {
    throw new VerifierError(`embedding size mismatch: expected ${texts.length}, got ${vectors.length}`);
  }
  return vectors;
}

function clusterEmbeddings(vectors: number[][], threshold: number): number[][] {
  const n = vectors.length;
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
      if (cosine(vectors[i], vectors[j]) >= threshold) union(i, j);
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

function extractKeywords(text: string, k = 6): string[] {
  const tokens = (text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter((t) => !STOPWORDS.has(t));
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([w]) => w);
}

function loadPolicyFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, p] of Object.entries(POLICY_FILES)) out[key] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  return out;
}

function fileKeywordHits(files: Record<string, string>, keywords: string[]): Record<string, string[]> {
  const hits: Record<string, string[]> = {};
  for (const name of Object.keys(files)) hits[name] = [];

  for (const [name, content] of Object.entries(files)) {
    const low = content.toLowerCase();
    for (const kw of keywords) if (low.includes(kw)) hits[name].push(kw);
  }

  const out: Record<string, string[]> = {};
  for (const [k, arr] of Object.entries(hits)) out[k] = [...new Set(arr)].sort();
  return out;
}

function feedbackText(row: FeedbackRow): string {
  return `${row.feedback_type}\n${row.context}\n${row.lesson}`.trim();
}

function runAudit(windowDays: number | undefined, similarityThreshold: number, repeatThreshold: number, limit: number | undefined): Record<string, any> {
  const rows = fetchFeedback(windowDays, limit);
  if (!rows.length) {
    return {
      generated_at: new Date().toISOString(),
      total_feedback_entries: 0,
      message: "No feedback rows found.",
      clusters: [],
      broken_loops: [],
      closure_rate: 0,
    };
  }

  const texts = rows.map(feedbackText);
  const vectors = embedTexts(texts);
  const clusters = clusterEmbeddings(vectors, similarityThreshold);
  const files = loadPolicyFiles();

  const rowAnalysis: Record<string, any>[] = [];
  for (const row of rows) {
    const keywords = extractKeywords(`${row.context} ${row.lesson}`);
    const hits = fileKeywordHits(files, keywords);
    const target = TARGET_FILE_BY_TYPE[row.feedback_type] || "agents";
    const targetHits = hits[target] || [];
    const anyHits = [...new Set(Object.values(hits).flat())].sort();
    const closed = Boolean(targetHits.length || anyHits.length);

    rowAnalysis.push({
      id: row.id,
      timestamp: row.timestamp,
      feedback_type: row.feedback_type,
      context: row.context,
      lesson: row.lesson,
      applied: row.applied,
      keywords,
      target_file: path.basename(POLICY_FILES[target]),
      keyword_hits: hits,
      closed,
    });
  }

  const clusterReports: Record<string, any>[] = [];
  const brokenLoops: Record<string, any>[] = [];
  const unclosedTopics: Record<string, any>[] = [];

  for (const idxs of clusters) {
    const entries = idxs.map((i) => rowAnalysis[i]);
    const size = entries.length;
    const exemplar = entries.sort((a, b) => ((b.lesson || b.context).length - (a.lesson || a.context).length))[0];
    const closedCount = entries.filter((e) => e.closed).length;
    const closureRate = size ? closedCount / size : 0;
    const topKeywords = [...new Map(entries.flatMap((e) => e.keywords).map((k: string) => [k, 0])).keys()].slice(0, 8);

    const report = {
      cluster_size: size,
      feedback_ids: entries.map((e) => e.id),
      feedback_types: [...new Set(entries.map((e) => e.feedback_type))].sort(),
      topic_example: exemplar.lesson || exemplar.context,
      top_keywords: topKeywords,
      closed_entries: closedCount,
      unclosed_entries: size - closedCount,
      closure_rate: Number(closureRate.toFixed(3)),
      broken_loop: size > repeatThreshold,
    };

    clusterReports.push(report);
    if (report.broken_loop) brokenLoops.push(report);
    if (report.unclosed_entries > 0) unclosedTopics.push(report);
  }

  const total = rowAnalysis.length;
  const closedTotal = rowAnalysis.filter((r) => r.closed).length;
  const repeatedEntries = clusters.filter((c) => c.length > 1).reduce((s, c) => s + c.length, 0);
  const uniqueEntries = total - repeatedEntries;

  unclosedTopics.sort((a, b) => (b.unclosed_entries - a.unclosed_entries) || (b.cluster_size - a.cluster_size));

  return {
    generated_at: new Date().toISOString(),
    settings: {
      window_days: windowDays,
      similarity_threshold: similarityThreshold,
      repeat_threshold: repeatThreshold,
      limit,
    },
    total_feedback_entries: total,
    cluster_count: clusters.length,
    unique_entries: uniqueEntries,
    repeated_entries: repeatedEntries,
    closure_rate: total ? Number((closedTotal / total).toFixed(3)) : 0,
    closed_entries: closedTotal,
    unclosed_entries: total - closedTotal,
    clusters: clusterReports,
    broken_loops: brokenLoops,
    top_unclosed_feedback_items: unclosedTopics.slice(0, 5),
    entries: rowAnalysis,
  };
}

function summarizeReport(audit: Record<string, any>): Record<string, any> {
  const brokenLoops = audit.broken_loops || [];
  return {
    generated_at: audit.generated_at,
    total_feedback_entries: Number(audit.total_feedback_entries || 0),
    unique_entries: Number(audit.unique_entries || 0),
    repeated_entries: Number(audit.repeated_entries || 0),
    closure_rate: Number(audit.closure_rate || 0),
    broken_loop_topics: brokenLoops.length,
    top_unclosed_feedback_items: (audit.top_unclosed_feedback_items || []).slice(0, 5),
  };
}

function criticalAlerts(audit: Record<string, any>): Record<string, any>[] {
  const critical: Record<string, any>[] = [];
  for (const cluster of (audit.broken_loops || []) as Record<string, any>[]) {
    if ((cluster.unclosed_entries || 0) >= 2 || (cluster.closure_rate ?? 1) < 0.5) {
      critical.push({
        feedback_ids: cluster.feedback_ids || [],
        topic_example: cluster.topic_example || "",
        cluster_size: cluster.cluster_size || 0,
        unclosed_entries: cluster.unclosed_entries || 0,
        closure_rate: cluster.closure_rate || 0,
        top_keywords: cluster.top_keywords || [],
        message: "Critical unclosed feedback loop detected.",
      });
    }
  }
  return critical;
}

function maybeWriteJson(outPath: string | undefined, payload: unknown): void {
  if (!outPath) return;
  const p = path.resolve(outPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

type Args = {
  command: "audit" | "report" | "alert";
  windowDays?: number;
  limit?: number;
  similarityThreshold: number;
  repeatThreshold: number;
  output?: string;
};

function parseArgs(argv: string[]): Args {
  const command = (argv[0] || "") as Args["command"];
  if (!command || !["audit", "report", "alert"].includes(command)) {
    throw new VerifierError("Usage: feedback_verifier.ts {audit|report|alert} [--window-days N] [--limit N] [--similarity-threshold F] [--repeat-threshold N] [--output FILE]");
  }

  const args: Args = {
    command,
    similarityThreshold: 0.82,
    repeatThreshold: 2,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === "--window-days" && n) {
      args.windowDays = Number.parseInt(n, 10);
      i += 1;
    } else if (a === "--limit" && n) {
      args.limit = Number.parseInt(n, 10);
      i += 1;
    } else if (a === "--similarity-threshold" && n) {
      args.similarityThreshold = Number.parseFloat(n);
      i += 1;
    } else if (a === "--repeat-threshold" && n) {
      args.repeatThreshold = Number.parseInt(n, 10);
      i += 1;
    } else if (a === "--output" && n) {
      args.output = n;
      i += 1;
    }
  }

  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const audit = runAudit(
    args.windowDays,
    Math.min(0.99, Math.max(0.1, args.similarityThreshold)),
    Math.max(1, args.repeatThreshold),
    args.limit
  );

  if (args.command === "audit") {
    maybeWriteJson(args.output, audit);
    console.log(JSON.stringify(audit, null, 2));
    return 0;
  }

  if (args.command === "report") {
    const report = summarizeReport(audit);
    maybeWriteJson(args.output, report);
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  if (args.command === "alert") {
    const alerts = criticalAlerts(audit);
    const out = { generated_at: audit.generated_at, alerts, count: alerts.length };
    maybeWriteJson(args.output, out);
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  throw new VerifierError(`Unknown command: ${args.command}`);
}

main()
  .then((code) => process.exit(code))
  .catch((exc) => {
    const msg = exc instanceof Error ? exc.message : String(exc);
    console.error(`Error: ${msg}`);
    process.exit(1);
  });
