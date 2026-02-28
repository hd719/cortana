#!/usr/bin/env npx tsx

import { query } from "../lib/db.js";

function runPsql(sql: string): string {
  return query(sql).trim();
}

function parseJsonRows(raw: string): Array<Record<string, any>> {
  const text = (raw ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as any;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ensureSchema(): void {
  runPsql(`
ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS supersedes_id BIGINT;

ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS superseded_by BIGINT;

ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

UPDATE cortana_memory_semantic older
SET superseded_by = newer.id,
    superseded_at = COALESCE(older.superseded_at, NOW())
FROM cortana_memory_semantic newer
WHERE newer.supersedes_id = older.id
  AND (older.superseded_by IS NULL OR older.superseded_by != newer.id);

CREATE INDEX IF NOT EXISTS idx_memory_semantic_supersedes_id
  ON cortana_memory_semantic(supersedes_id);

CREATE INDEX IF NOT EXISTS idx_memory_semantic_superseded_by
  ON cortana_memory_semantic(superseded_by);
`);
}

function chain(memoryId: number): Array<Record<string, any>> {
  const sql = `
WITH RECURSIVE walk AS (
  SELECT id, supersedes_id, superseded_by, 0::int AS depth_back
  FROM cortana_memory_semantic
  WHERE id = ${Number(memoryId)}

  UNION ALL

  SELECT p.id, p.supersedes_id, p.superseded_by, walk.depth_back + 1
  FROM cortana_memory_semantic p
  JOIN walk ON walk.supersedes_id = p.id
), oldest AS (
  SELECT id FROM walk ORDER BY depth_back DESC LIMIT 1
), chain AS (
  SELECT s.id, s.supersedes_id, s.superseded_by, s.superseded_at, s.active,
         s.fact_type, s.subject, s.predicate, s.object_value,
         s.first_seen_at, s.last_seen_at,
         0::int AS depth
  FROM cortana_memory_semantic s
  JOIN oldest o ON o.id = s.id

  UNION ALL

  SELECT n.id, n.supersedes_id, n.superseded_by, n.superseded_at, n.active,
         n.fact_type, n.subject, n.predicate, n.object_value,
         n.first_seen_at, n.last_seen_at,
         chain.depth + 1
  FROM cortana_memory_semantic n
  JOIN chain ON n.supersedes_id = chain.id
)
SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.depth ASC), '[]'::json)::text
FROM chain t;
`;
  return parseJsonRows(runPsql(sql));
}

function prune(maxDepth: number, dryRun: boolean): Record<string, any> {
  const depth = Math.max(0, Number(maxDepth));
  const sqlCandidates = `
WITH RECURSIVE heads AS (
  SELECT id AS head_id, id, 0::int AS depth_from_head
  FROM cortana_memory_semantic
  WHERE superseded_by IS NULL
), chain AS (
  SELECT * FROM heads

  UNION ALL

  SELECT chain.head_id, prev.id, chain.depth_from_head + 1
  FROM chain
  JOIN cortana_memory_semantic cur ON cur.id = chain.id
  JOIN cortana_memory_semantic prev ON prev.id = cur.supersedes_id
), victims AS (
  SELECT c.id, c.head_id, c.depth_from_head
  FROM chain c
  JOIN cortana_memory_semantic s ON s.id = c.id
  WHERE c.depth_from_head > ${depth}
    AND (s.superseded_by IS NOT NULL OR s.superseded_at IS NOT NULL)
)
SELECT COALESCE(json_agg(row_to_json(v) ORDER BY v.head_id, v.depth_from_head, v.id), '[]'::json)::text
FROM victims v;
`;
  const victims = parseJsonRows(runPsql(sqlCandidates));
  const victimIds = victims.map((v) => Number(v.id)).filter((v) => Number.isFinite(v));

  if (victimIds.length && !dryRun) {
    const ids = `{${Array.from(new Set(victimIds)).sort((a, b) => a - b).join(",")}}`;
    runPsql(`
UPDATE cortana_memory_semantic
SET active = FALSE,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'supersession_pruned_at', NOW()::text,
      'supersession_prune_max_depth', ${depth}
    )
WHERE id = ANY('${ids}'::bigint[]);
`);
  }

  return {
    max_depth: depth,
    dry_run: dryRun,
    pruned: dryRun ? 0 : new Set(victimIds).size,
    candidates: victimIds.length,
    ids: Array.from(new Set(victimIds)).sort((a, b) => a - b),
  };
}

function printHelp(): void {
  const text = `usage: supersession.ts [-h] {chain,prune} ...\n\nSupersession chain operations\n\noptions:\n  -h, --help  show this help message and exit`;
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
  ensureSchema();

  if (cmd === "chain") {
    const id = argv[1];
    if (!id) {
      console.error("memory_id is required");
      process.exit(2);
    }
    console.log(JSON.stringify({ memory_id: Number(id), chain: chain(Number(id)) }, null, 2));
    return;
  }

  if (cmd === "prune") {
    let maxDepth = 3;
    let dryRun = false;
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      const next = argv[i + 1];
      if (arg === "--max-depth" && next) {
        maxDepth = Number.parseInt(next, 10);
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
    console.log(JSON.stringify(prune(maxDepth, dryRun), null, 2));
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
