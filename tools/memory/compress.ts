#!/usr/bin/env npx tsx

import { createHash } from "crypto";
import { runPsql } from "../lib/db.js";

type EpisodicEntry = {
  id: number;
  happened_at: string;
  summary: string;
  details: string;
  tags: string[];
  participants: string[];
};

type Cluster = {
  id: number;
  entries: EpisodicEntry[];
  featureCounts: Map<string, number>;
};

const GENERIC_TAGS = new Set([
  "memory",
  "daily_memory",
  "heartbeat_ingest",
  "note",
  "notes",
  "log",
  "general",
]);

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "from",
  "this",
  "have",
  "will",
  "were",
  "been",
  "about",
  "into",
  "when",
  "what",
  "where",
  "your",
  "their",
  "them",
  "then",
  "than",
  "just",
  "also",
  "more",
  "very",
  "only",
  "over",
  "under",
  "need",
  "next",
]);

function q(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psql(sql: string, capture = false): string {
  const res = runPsql(sql, {
    args: ["-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", "\t", "-X"],
  });
  if (res.status !== 0) {
    const msg = (res.stderr ?? "").trim() || "psql command failed";
    throw new Error(msg);
  }
  if (!capture) return "";
  return (res.stdout ?? "").trim();
}

function fp(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(p ?? "");
    h.update("|");
  }
  return h.digest("hex").slice(0, 40);
}

function ensureFidelityColumn(): void {
  const sql = `
    ALTER TABLE cortana_memory_semantic
    ADD COLUMN IF NOT EXISTS fidelity_score numeric(5,4);

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'cortana_memory_semantic_fidelity_score_check'
      ) THEN
        ALTER TABLE cortana_memory_semantic
        ADD CONSTRAINT cortana_memory_semantic_fidelity_score_check
        CHECK (fidelity_score IS NULL OR (fidelity_score >= 0 AND fidelity_score <= 1));
      END IF;
    END $$;
    `;
  psql(sql);
}

function parseArray(raw: string): string[] {
  if (!raw) return [];
  return raw.split(",").filter((x) => x);
}

function fetchRecentEpisodic(sinceHours: number): EpisodicEntry[] {
  const sql = `
    SELECT
      id,
      happened_at::text,
      COALESCE(summary, ''),
      COALESCE(details, ''),
      COALESCE(array_to_string(tags, ','), ''),
      COALESCE(array_to_string(participants, ','), '')
    FROM cortana_memory_episodic
    WHERE active = TRUE
      AND happened_at >= NOW() - INTERVAL '${sinceHours} hours'
    ORDER BY happened_at ASC;
    `;
  const out = psql(sql, true);
  const rows: EpisodicEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length !== 6) continue;
    rows.push({
      id: Number.parseInt(parts[0] ?? "0", 10),
      happened_at: parts[1] ?? "",
      summary: parts[2] ?? "",
      details: parts[3] ?? "",
      tags: parseArray(parts[4] ?? ""),
      participants: parseArray(parts[5] ?? ""),
    });
  }
  return rows;
}

function tokenize(text: string): string[] {
  const words = text.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? [];
  return words.map((w) => w.toLowerCase()).filter((w) => !STOPWORDS.has(w));
}

function extractFeatures(entry: EpisodicEntry): Set<string> {
  const tags = new Set(
    entry.tags
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t && !GENERIC_TAGS.has(t))
  );

  const toks = tokenize(`${entry.summary}\n${entry.details}`);
  const counts = new Map<string, number>();
  for (const t of toks) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const common = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);

  for (const w of common) tags.add(w);
  return tags;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0.0;
  let inter = 0;
  for (const v of a) {
    if (b.has(v)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union ? inter / union : 0.0;
}

function clusterEntries(entries: EpisodicEntry[], threshold = 0.25): Cluster[] {
  const clusters: Cluster[] = [];
  for (const entry of entries) {
    const features = extractFeatures(entry);
    let bestIdx = -1;
    let bestScore = 0.0;
    for (let i = 0; i < clusters.length; i += 1) {
      const c = clusters[i];
      const featureSet = new Set(c.featureCounts.keys());
      const score = jaccard(features, featureSet);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    let target: Cluster;
    if (bestIdx >= 0 && bestScore >= threshold) {
      target = clusters[bestIdx];
    } else {
      target = { id: clusters.length + 1, entries: [], featureCounts: new Map() };
      clusters.push(target);
    }

    target.entries.push(entry);
    for (const f of features) {
      target.featureCounts.set(f, (target.featureCounts.get(f) ?? 0) + 1);
    }
  }
  return clusters;
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim().replace(/^[-•\t ]+|[-•\t ]+$/g, "");
}

function pickItems(lines: string[], patterns: string[], limit = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const regexes = patterns.map((p) => new RegExp(p, "i"));
  for (const raw of lines) {
    const l = normalizeLine(raw);
    if (!l) continue;
    if (regexes.some((r) => r.test(l))) {
      const key = l.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(l);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function extractEntities(text: string): Set<string> {
  const entities = new Set<string>();
  const caps = text.match(/\b[A-Z][a-zA-Z0-9_+-]{2,}\b/g) ?? [];
  for (const m of caps) entities.add(m.toLowerCase());
  const ids = text.match(/\b(?:task|issue|pr|ticket)[\s:#-]*\d+\b/gi) ?? [];
  for (const m of ids) entities.add(m.toLowerCase().replace(/\s+/g, ""));
  const nums = text.match(/\b\d+(?:\.\d+)?(?:%|h|hr|hrs|am|pm|days?|weeks?)\b/gi) ?? [];
  for (const m of nums) entities.add(m.toLowerCase());
  return entities;
}

function buildCompression(cluster: Cluster): Record<string, any> {
  const allLines: string[] = [];
  const combinedTextParts: string[] = [];

  for (const e of cluster.entries) {
    const combined = `${e.summary || ""}\n${e.details || ""}`.trim();
    combinedTextParts.push(combined);
    const parts = combined.split(/[\n\.]+/);
    for (const p of parts) {
      if (p && p.trim()) allLines.push(p);
    }
  }

  const facts = pickItems(allLines, ["\\b(is|are|was|were|has|have|had|updated|completed|deployed|fixed)\\b", "\\b\\d"], 7);
  const decisions = pickItems(allLines, ["\\b(decid|chose|choice|plan|will|should|recommend|approved)\\b"], 5);
  const actions = pickItems(allLines, ["\\b(todo|action|follow up|next step|need to|pending|blocker|deadline)\\b"], 6);

  const topTopics = Array.from(cluster.featureCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k]) => k);
  const topicLabel = topTopics.length ? topTopics.join(", ") : `cluster-${cluster.id}`;

  const bodyLines: string[] = [`Topic: ${topicLabel}`];
  if (facts.length) {
    bodyLines.push("Key facts:");
    bodyLines.push(...facts.map((x) => `- ${x}`));
  }
  if (decisions.length) {
    bodyLines.push("Decisions:");
    bodyLines.push(...decisions.map((x) => `- ${x}`));
  }
  if (actions.length) {
    bodyLines.push("Action items:");
    bodyLines.push(...actions.map((x) => `- ${x}`));
  }

  if (!facts.length && !decisions.length && !actions.length) {
    const fallback = allLines
      .map((x) => normalizeLine(x))
      .filter((x) => x)
      .slice(0, 8);
    if (fallback.length) {
      bodyLines.push("Summary:");
      bodyLines.push(...fallback.map((x) => `- ${x}`));
    }
  }

  const compressedText = bodyLines.join("\n").trim();
  const sourceText = combinedTextParts.join("\n");

  const sourceEntities = extractEntities(sourceText);
  const compressedEntities = extractEntities(compressedText);
  const overlap = new Set<string>();
  for (const e of sourceEntities) {
    if (compressedEntities.has(e)) overlap.add(e);
  }

  let fidelity = 0.0;
  if (sourceEntities.size) {
    fidelity = overlap.size / sourceEntities.size;
  } else {
    fidelity = compressedText ? 1.0 : 0.0;
  }

  const srcHasDecisions = /\b(decid|chose|approved|plan)\b/i.test(sourceText);
  const srcHasActions = /\b(todo|follow up|next step|need to|pending|blocker)\b/i.test(sourceText);
  if (srcHasDecisions && !decisions.length) fidelity *= 0.9;
  if (srcHasActions && !actions.length) fidelity *= 0.9;

  fidelity = Math.max(0.0, Math.min(1.0, Math.round(fidelity * 10000) / 10000));

  return {
    topic: topicLabel,
    text: compressedText,
    facts,
    decisions,
    actions,
    fidelity,
    source_entities: Array.from(sourceEntities).sort(),
    compressed_entities: Array.from(compressedEntities).sort(),
    entity_overlap: Array.from(overlap).sort(),
  };
}

function insertSemantic(
  compression: Record<string, any>,
  cluster: Cluster,
  sinceHours: number,
  dryRun: boolean
): boolean {
  const entryIds = cluster.entries.map((e) => e.id);
  const subject = `memory_cluster:${cluster.id}`;
  const predicate = "daily_distillation";
  const objectValue = compression.text;
  const sourceRef = `episodic:${Math.min(...entryIds)}-${Math.max(...entryIds)}:h${sinceHours}`;
  const fingerprint = fp(subject, predicate, objectValue, sourceRef);

  const metadata = {
    engine: "semantic-compression-v1",
    entry_ids: entryIds,
    entry_count: entryIds.length,
    topic: compression.topic,
    facts: compression.facts,
    decisions: compression.decisions,
    actions: compression.actions,
    source_entities: compression.source_entities,
    compressed_entities: compression.compressed_entities,
    entity_overlap: compression.entity_overlap,
  };

  const confidence = Math.max(0.5, Math.min(0.98, 0.55 + compression.fidelity * 0.4));

  const sql = `
    INSERT INTO cortana_memory_semantic
      (fact_type, subject, predicate, object_value, confidence, trust, stability,
       first_seen_at, last_seen_at, source_type, source_ref, fingerprint, metadata, fidelity_score)
    VALUES
      ('fact', ${q(subject)}, ${q(predicate)}, ${q(objectValue)},
       ${confidence.toFixed(4)}, 0.850, 0.600, NOW(), NOW(),
       'semantic_compression', ${q(sourceRef)}, ${q(fingerprint)}, ${q(JSON.stringify(metadata))}::jsonb,
       ${compression.fidelity.toFixed(4)})
    ON CONFLICT (fact_type, subject, predicate, object_value)
    DO UPDATE SET
      last_seen_at = NOW(),
      source_type = EXCLUDED.source_type,
      source_ref = EXCLUDED.source_ref,
      fingerprint = EXCLUDED.fingerprint,
      metadata = EXCLUDED.metadata,
      confidence = EXCLUDED.confidence,
      fidelity_score = EXCLUDED.fidelity_score,
      active = TRUE;
    `;

  if (dryRun) return true;
  psql(sql);
  return true;
}

function printHelp(): void {
  const text = `usage: compress.ts [-h] [--since-hours SINCE_HOURS] [--dry-run] [--min-cluster-size MIN_CLUSTER_SIZE]\n\nCompress recent episodic memories into semantic memory.\n\noptions:\n  -h, --help            show this help message and exit\n  --since-hours SINCE_HOURS  Lookback window in hours (recommended 24-48).\n  --dry-run             Analyze without writing to DB.\n  --min-cluster-size MIN_CLUSTER_SIZE  Skip clusters smaller than this size.`;
  console.log(text);
}

function parseArgs(argv: string[]): { sinceHours: number; dryRun: boolean; minClusterSize: number } {
  const args = { sinceHours: 36, dryRun: false, minClusterSize: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "--since-hours" && next) {
      args.sinceHours = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--min-cluster-size" && next) {
      args.minClusterSize = Number.parseInt(next, 10);
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
  const sinceHours = Math.max(1, Math.min(168, args.sinceHours));

  ensureFidelityColumn();
  const rows = fetchRecentEpisodic(sinceHours);
  if (!rows.length) {
    console.log(
      JSON.stringify({ ok: true, message: "No episodic memories in lookback window.", since_hours: sinceHours })
    );
    return;
  }

  const clusters = clusterEntries(rows);
  let written = 0;
  const outputs: Array<Record<string, any>> = [];

  for (const c of clusters) {
    if (c.entries.length < args.minClusterSize) continue;
    const comp = buildCompression(c);
    insertSemantic(comp, c, sinceHours, args.dryRun);
    written += 1;
    outputs.push({
      cluster_id: c.id,
      entry_ids: c.entries.map((e) => e.id),
      entry_count: c.entries.length,
      topic: comp.topic,
      fidelity: comp.fidelity,
    });
  }

  const out = {
    ok: true,
    dry_run: args.dryRun,
    since_hours: sinceHours,
    episodic_entries: rows.length,
    clusters_total: clusters.length,
    clusters_written: written,
    results: outputs,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
