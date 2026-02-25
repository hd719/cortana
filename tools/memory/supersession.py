#!/usr/bin/env python3
"""Supersession chain tools for semantic memory.

Usage:
  python3 tools/memory/supersession.py chain <memory_id>
  python3 tools/memory/supersession.py prune [--max-depth 3] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from typing import Any

DB_NAME = "cortana"
DB_BIN = "/opt/homebrew/opt/postgresql@17/bin"


def run_psql(sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{DB_BIN}:{env.get('PATH', '')}"
    cmd = ["psql", DB_NAME, "-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql]
    out = subprocess.run(cmd, text=True, capture_output=True, env=env)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or out.stdout.strip() or "psql failed")
    return out.stdout.strip()


def parse_json_rows(raw: str) -> list[dict[str, Any]]:
    text = (raw or "").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def ensure_schema() -> None:
    run_psql(
        """
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
"""
    )


def chain(memory_id: int) -> list[dict[str, Any]]:
    sql = f"""
WITH RECURSIVE walk AS (
  SELECT id, supersedes_id, superseded_by, 0::int AS depth_back
  FROM cortana_memory_semantic
  WHERE id = {int(memory_id)}

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
"""
    return parse_json_rows(run_psql(sql))


def prune(max_depth: int, dry_run: bool) -> dict[str, Any]:
    max_depth = max(0, int(max_depth))

    sql_candidates = f"""
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
  WHERE c.depth_from_head > {max_depth}
    AND (s.superseded_by IS NOT NULL OR s.superseded_at IS NOT NULL)
)
SELECT COALESCE(json_agg(row_to_json(v) ORDER BY v.head_id, v.depth_from_head, v.id), '[]'::json)::text
FROM victims v;
"""
    victims = parse_json_rows(run_psql(sql_candidates))
    victim_ids = [int(v["id"]) for v in victims if v.get("id")]

    if victim_ids and not dry_run:
        ids = "{" + ",".join(str(v) for v in sorted(set(victim_ids))) + "}"
        run_psql(
            f"""
UPDATE cortana_memory_semantic
SET active = FALSE,
    metadata = COALESCE(metadata, '{{}}'::jsonb) || jsonb_build_object(
      'supersession_pruned_at', NOW()::text,
      'supersession_prune_max_depth', {max_depth}
    )
WHERE id = ANY('{ids}'::bigint[]);
"""
        )

    return {
        "max_depth": max_depth,
        "dry_run": dry_run,
        "pruned": 0 if dry_run else len(set(victim_ids)),
        "candidates": len(victim_ids),
        "ids": sorted(set(victim_ids)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Supersession chain operations")
    sub = parser.add_subparsers(dest="command", required=True)

    p_chain = sub.add_parser("chain", help="Show full supersession history")
    p_chain.add_argument("memory_id", type=int)

    p_prune = sub.add_parser("prune", help="Deactivate deeply superseded chain members")
    p_prune.add_argument("--max-depth", type=int, default=3)
    p_prune.add_argument("--dry-run", action="store_true")

    args = parser.parse_args()
    ensure_schema()

    if args.command == "chain":
        print(json.dumps({"memory_id": args.memory_id, "chain": chain(args.memory_id)}, indent=2))
        return 0

    if args.command == "prune":
        print(json.dumps(prune(args.max_depth, args.dry_run), indent=2))
        return 0

    parser.error("Unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
