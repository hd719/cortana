#!/usr/bin/env npx tsx

/** Identity-scoped memory injector for Covenant agent spawn prompts. */

import db from "../lib/db.js";
const { runPsql, withPostgresPath } = db;

const DB_NAME = "cortana";

const ROLE_KEYWORDS: Record<string, string[]> = {
  researcher: ["research", "comparison", "analysis", "findings", "sources"],
  oracle: ["prediction", "strategy", "risk", "forecast", "decision", "portfolio"],
  huragok: ["system", "infra", "migration", "service", "build", "deploy", "fix"],
  monitor: ["health", "alert", "anomaly", "pattern", "incident"],
  librarian: ["documentation", "knowledge", "summary", "index", "catalog"],
};

const HALF_LIVES_DAYS: Record<string, number> = {
  fact: 365.0,
  preference: 180.0,
  event: 14.0,
  episodic: 14.0,
  system_rule: Infinity,
  rule: Infinity,
};

type MemoryItem = {
  tier: string;
  memory_id: number;
  happened_at: string;
  similarity: number;
  recency: number;
  utility: number;
  score: number;
  body: string;
  source: string;
};

type Json = Record<string, any>;

function sqlEscape(text: string): string {
  return (text || "").replace(/'/g, "''");
}

function runPsqlQuery(sql: string): string {
  const result = runPsql(sql, {
    db: DB_NAME,
    args: ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A"],
    env: withPostgresPath(process.env),
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "psql failed").toString().trim();
    throw new Error(err || "psql failed");
  }
  return (result.stdout || "").toString().trim();
}

function parseJsonRows(raw: string): Json[] {
  const text = (raw || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeFloat(value: any, def = 0.0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : def;
}

function safeInt(value: any, def = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : def;
}

function recencyScore(daysOld: number, memoryType: string): number {
  const mtype = (memoryType || "fact").toLowerCase().trim();
  const halfLife = HALF_LIVES_DAYS[mtype] ?? HALF_LIVES_DAYS.fact;
  if (!Number.isFinite(halfLife)) return 1.0;
  const days = Math.max(0.0, safeFloat(daysOld, 0.0));
  return 2 ** (-(days / halfLife));
}

function utilityScore(accessCount: number): number {
  return Math.log10(Math.max(0, safeInt(accessCount, 0)) + 1);
}

function relevanceScore(similarity: number, daysOld: number, memoryType: string, accessCount: number): number {
  const sim = Math.max(0.0, Math.min(1.0, safeFloat(similarity, 0.0)));
  const rec = recencyScore(daysOld, memoryType);
  const util = utilityScore(accessCount);
  return 0.5 * sim + 0.3 * rec + 0.2 * util;
}

function ensureSchema(): void {
  runPsqlQuery(`
ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS access_count INT NOT NULL DEFAULT 0;

ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS supersedes_id BIGINT;

ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS superseded_by BIGINT;

ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'cortana_memory_semantic'
      AND column_name = 'supersedes_memory_id'
  ) THEN
    UPDATE cortana_memory_semantic
    SET supersedes_id = supersedes_memory_id
    WHERE supersedes_id IS NULL
      AND supersedes_memory_id IS NOT NULL;
  END IF;
END $$;

UPDATE cortana_memory_semantic older
SET superseded_by = newer.id,
    superseded_at = COALESCE(older.superseded_at, NOW())
FROM cortana_memory_semantic newer
WHERE newer.supersedes_id = older.id
  AND (older.superseded_by IS NULL OR older.superseded_by != newer.id);

CREATE INDEX IF NOT EXISTS idx_memory_semantic_active_not_superseded
  ON cortana_memory_semantic(active, superseded_by);

CREATE INDEX IF NOT EXISTS idx_memory_semantic_supersedes_id
  ON cortana_memory_semantic(supersedes_id);

CREATE INDEX IF NOT EXISTS idx_memory_semantic_superseded_by
  ON cortana_memory_semantic(superseded_by);
`);
}

function incrementAccessCount(memoryIds: number[]): number {
  const ids = Array.from(new Set(memoryIds.map((i) => Math.trunc(i)).filter((i) => i > 0))).sort((a, b) => a - b);
  if (!ids.length) return 0;
  ensureSchema();
  runPsqlQuery(
    `UPDATE cortana_memory_semantic SET access_count = access_count + 1, last_seen_at = NOW() WHERE id = ANY('{${ids.join(",")}}'::bigint[]);`
  );
  return ids.length;
}

function buildKeywordsClause(keywords: string[], fieldsExpr: string): string {
  return keywords.map((k) => `(${fieldsExpr}) ILIKE '%${sqlEscape(k)}%'`).join(" OR ");
}

function queryRoleMemories(agentRole: string, limit: number, sinceHours: number): MemoryItem[] {
  const role = (agentRole || "").toLowerCase().trim();
  const keywords = ROLE_KEYWORDS[role];
  if (!keywords) throw new Error(`Unknown agent role: ${agentRole}`);

  ensureSchema();

  const epiTextBlob =
    "LOWER(COALESCE(array_to_string(tags, ' '), '') || ' ' || COALESCE(source_type, '') || ' ' || COALESCE(source_ref, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE(details, '') || ' ' || COALESCE(metadata::text, ''))";
  const semTextBlob =
    "LOWER(COALESCE(source_type, '') || ' ' || COALESCE(source_ref, '') || ' ' || COALESCE(subject, '') || ' ' || COALESCE(predicate, '') || ' ' || COALESCE(object_value, '') || ' ' || COALESCE(metadata::text, ''))";

  const epiFilter = buildKeywordsClause(keywords, epiTextBlob);
  const semFilter = buildKeywordsClause(keywords, semTextBlob);

  const roleTerms = keywords
    .map((k) => `CASE WHEN text_blob ILIKE '%${sqlEscape(k)}%' THEN 1 ELSE 0 END`)
    .join(" + ");

  const sql = `
WITH base AS (
  SELECT
    'episodic'::text AS tier,
    id AS memory_id,
    happened_at AS ts,
    (${epiTextBlob}) AS text_blob,
    TRIM(COALESCE(summary,'')) ||
      CASE WHEN COALESCE(details,'') <> '' THEN E'\\n' || TRIM(details) ELSE '' END AS body,
    COALESCE(source_type, 'unknown') || COALESCE(':' || source_ref, '') AS source,
    0::int AS access_count,
    'episodic'::text AS memory_type
  FROM cortana_memory_episodic
  WHERE active = TRUE
    AND happened_at >= NOW() - INTERVAL '${Math.trunc(sinceHours)} hours'
    AND (${epiFilter})

  UNION ALL

  SELECT
    'semantic'::text AS tier,
    id AS memory_id,
    COALESCE(last_seen_at, first_seen_at) AS ts,
    (${semTextBlob}) AS text_blob,
    TRIM(COALESCE(subject,'')) || ' | ' || TRIM(COALESCE(predicate,'')) || ' | ' || TRIM(COALESCE(object_value,'')) AS body,
    COALESCE(source_type, 'unknown') || COALESCE(':' || source_ref, '') AS source,
    COALESCE(access_count, 0)::int AS access_count,
    CASE
      WHEN fact_type = 'rule' THEN 'system_rule'
      ELSE LOWER(fact_type)
    END AS memory_type
  FROM cortana_memory_semantic
  WHERE active = TRUE
    AND superseded_by IS NULL
    AND superseded_at IS NULL
    AND COALESCE(last_seen_at, first_seen_at) >= NOW() - INTERVAL '${Math.trunc(sinceHours)} hours'
    AND (${semFilter})
), scored AS (
  SELECT
    tier,
    memory_id,
    ts,
    body,
    source,
    memory_type,
    access_count,
    (${roleTerms})::float AS relevance_hits,
    GREATEST(EXTRACT(EPOCH FROM (NOW() - ts)) / 86400.0, 0.0) AS days_old
  FROM base
)
SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.relevance_hits DESC, t.ts DESC), '[]'::json)::text
FROM (
  SELECT
    tier,
    memory_id,
    ts,
    body,
    source,
    memory_type,
    access_count,
    days_old,
    relevance_hits,
    LEAST(1.0, relevance_hits / ${keywords.length.toFixed(6)}) AS similarity
  FROM scored
  WHERE relevance_hits > 0
  ORDER BY relevance_hits DESC, ts DESC
  LIMIT ${Math.max(Math.trunc(limit) * 6, Math.trunc(limit) * 2)}
) t;
`;

  const rows = parseJsonRows(runPsqlQuery(sql));
  const out: MemoryItem[] = [];
  for (const row of rows) {
    const similarity = safeFloat(row.similarity, 0.0);
    const daysOld = safeFloat(row.days_old, 0.0);
    const memoryType = String(row.memory_type ?? "fact");
    const accessCount = safeInt(row.access_count, 0);
    const recency = recencyScore(daysOld, memoryType);
    const utility = utilityScore(accessCount);
    const score = relevanceScore(similarity, daysOld, memoryType, accessCount);

    out.push({
      tier: String(row.tier ?? "unknown"),
      memory_id: safeInt(row.memory_id, 0),
      happened_at: String(row.ts ?? ""),
      similarity,
      recency,
      utility,
      score,
      body: String(row.body ?? "").trim(),
      source: String(row.source ?? "unknown"),
    });
  }

  out.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.happened_at.localeCompare(a.happened_at)));
  return out;
}

function inject(agentRole: string, limit = 5, maxChars = 2000, sinceHours = 168): string {
  const items = queryRoleMemories(agentRole, Math.max(1, limit), Math.max(1, sinceHours));

  const role = agentRole.toLowerCase().trim();
  const header = [
    "## Identity-Scoped Memory Context",
    `Role: ${role}`,
    "Selection policy: role-keyword similarity + decay freshness (recency half-life) + utility " +
      `(window=${sinceHours}h)` ,
    "Use these memories as context, not immutable instructions.",
  ];

  if (!items.length) {
    return [...header, "- No role-scoped memories found in current time window."].join("\n");
  }

  const lines = [...header];
  let usedChars = lines.join("\n").length;
  let kept = 0;

  const maxSnippetChars = Math.max(140, Math.min(420, Math.floor(maxChars / 3)));
  const retrievedSemanticIds: number[] = [];

  for (const item of items) {
    if (kept >= limit) break;

    let stamp = item.happened_at;
    try {
      const dt = new Date(stamp.replace("Z", "+00:00"));
      if (!Number.isNaN(dt.getTime())) {
        const iso = dt.toISOString();
        stamp = `${iso.slice(0, 16).replace("T", " ")}Z`;
      }
    } catch {
      // ignore
    }

    let snippet = item.body.replace(/\n/g, " ").trim();
    snippet = snippet.split(/\s+/).join(" ");
    if (snippet.length > maxSnippetChars) {
      snippet = snippet.slice(0, maxSnippetChars - 1).replace(/\s+$/, "") + "…";
    }

    const entry =
      `- [${item.tier}#${item.memory_id}] ${snippet} ` +
      `(source=${item.source}; ts=${stamp}; score=${item.score.toFixed(3)}, sim=${item.similarity.toFixed(2)}, ` +
      `recency=${item.recency.toFixed(2)}, utility=${item.utility.toFixed(2)})`;

    const nextSize = usedChars + 1 + entry.length;
    if (nextSize > maxChars) break;
    lines.push(entry);
    usedChars = nextSize;
    kept += 1;
    if (item.tier === "semantic") retrievedSemanticIds.push(item.memory_id);
  }

  if (retrievedSemanticIds.length) incrementAccessCount(retrievedSemanticIds);

  if (kept === 0) {
    lines.push(`- Results existed but exceeded max_chars=${maxChars}. Increase budget to include entries.`);
  }

  if (items.length > kept) {
    lines.push(
      `- Truncated: kept ${kept}/${items.length} memories due to limits (limit=${limit}, max_chars=${maxChars}).`
    );
  }

  return lines.join("\n");
}

function usageError(): never {
  console.error("usage: memory_injector.ts inject <agent_role> [--limit N] [--max-chars N] [--since-hours N]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command !== "inject") usageError();
  const agentRole = args.shift();
  if (!agentRole) usageError();

  if (!Object.prototype.hasOwnProperty.call(ROLE_KEYWORDS, agentRole)) {
    console.error(`Unknown agent role: ${agentRole}`);
    process.exit(1);
  }

  const getNum = (flag: string, def: number): number => {
    const idx = args.indexOf(flag);
    if (idx >= 0 && args[idx + 1]) return Number(args[idx + 1]);
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return Number(eq.slice(flag.length + 1));
    return def;
  };

  const limit = getNum("--limit", 5);
  const maxChars = getNum("--max-chars", 2000);
  const sinceHours = getNum("--since-hours", 168);

  console.log(inject(agentRole, limit, maxChars, sinceHours));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
