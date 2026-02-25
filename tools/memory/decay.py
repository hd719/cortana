#!/usr/bin/env python3
"""Memory freshness decay + supersession utilities for PostgreSQL memory tables."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
from typing import Any

DB_NAME = "cortana"
DB_BIN = "/opt/homebrew/opt/postgresql@17/bin"

HALF_LIVES_DAYS: dict[str, float] = {
    "fact": 365.0,
    "preference": 180.0,
    "event": 14.0,
    "episodic": 14.0,
    "system_rule": float("inf"),
    "rule": float("inf"),
}


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
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []


def ensure_schema() -> None:
    run_psql(
        """
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

-- Backfill superseded_by from supersedes_id links.
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
"""
    )


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def recency_score(days_old: float, memory_type: str) -> float:
    mtype = (memory_type or "fact").lower().strip()
    half_life = HALF_LIVES_DAYS.get(mtype, HALF_LIVES_DAYS["fact"])
    if math.isinf(half_life):
        return 1.0
    days = max(0.0, _safe_float(days_old, 0.0))
    return 2 ** (-(days / half_life))


def utility_score(access_count: int) -> float:
    return math.log10(max(0, _safe_int(access_count, 0)) + 1)


def relevance_score(similarity: float, days_old: float, memory_type: str, access_count: int) -> float:
    sim = max(0.0, min(1.0, _safe_float(similarity, 0.0)))
    rec = recency_score(days_old, memory_type)
    util = utility_score(access_count)
    return (0.5 * sim) + (0.3 * rec) + (0.2 * util)


def increment_access_count(memory_ids: list[int]) -> int:
    ids = sorted({int(i) for i in memory_ids if int(i) > 0})
    if not ids:
        return 0
    ensure_schema()
    run_psql(
        f"UPDATE cortana_memory_semantic SET access_count = access_count + 1, last_seen_at = NOW() WHERE id = ANY('{{{','.join(str(i) for i in ids)}}}'::bigint[]);"
    )
    return len(ids)


def active_semantic_filter_sql(alias: str = "s") -> str:
    a = alias.strip() or "s"
    return f"{a}.active = TRUE AND {a}.superseded_by IS NULL AND {a}.superseded_at IS NULL"


def mark_superseded(old_id: int, new_id: int) -> None:
    ensure_schema()
    old = int(old_id)
    new = int(new_id)
    run_psql(
        f"""
UPDATE cortana_memory_semantic
SET superseded_by = {new}, superseded_at = NOW(), active = FALSE
WHERE id = {old};

UPDATE cortana_memory_semantic
SET supersedes_id = {old}, superseded_by = NULL
WHERE id = {new};
"""
    )


def get_chain(memory_id: int) -> list[dict[str, Any]]:
    ensure_schema()
    mid = int(memory_id)
    sql = f"""
WITH RECURSIVE walk AS (
  SELECT id, supersedes_id, superseded_by, 0::int AS depth_back
  FROM cortana_memory_semantic
  WHERE id = {mid}

  UNION ALL

  SELECT p.id, p.supersedes_id, p.superseded_by, walk.depth_back + 1
  FROM cortana_memory_semantic p
  JOIN walk ON walk.supersedes_id = p.id
), oldest AS (
  SELECT id FROM walk ORDER BY depth_back DESC LIMIT 1
), chain AS (
  SELECT s.id, s.supersedes_id, s.superseded_by, s.superseded_at, s.first_seen_at, s.last_seen_at,
         s.fact_type, s.subject, s.predicate, s.object_value, 0::int AS depth
  FROM cortana_memory_semantic s
  JOIN oldest o ON o.id = s.id

  UNION ALL

  SELECT n.id, n.supersedes_id, n.superseded_by, n.superseded_at, n.first_seen_at, n.last_seen_at,
         n.fact_type, n.subject, n.predicate, n.object_value, chain.depth + 1
  FROM cortana_memory_semantic n
  JOIN chain ON n.supersedes_id = chain.id
)
SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.depth ASC), '[]'::json)::text
FROM chain t;
"""
    return parse_json_rows(run_psql(sql))


def cmd_chain(args: argparse.Namespace) -> int:
    rows = get_chain(args.memory_id)
    print(json.dumps({"memory_id": args.memory_id, "chain": rows}, indent=2))
    return 0


def cmd_stats(_: argparse.Namespace) -> int:
    ensure_schema()
    sql = """
WITH sem AS (
  SELECT
    fact_type AS memory_type,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE superseded_by IS NOT NULL OR superseded_at IS NOT NULL) AS superseded,
    AVG(GREATEST(EXTRACT(EPOCH FROM (NOW() - COALESCE(last_seen_at, first_seen_at))) / 86400.0, 0.0)) AS avg_days_old,
    AVG(access_count)::float AS avg_access
  FROM cortana_memory_semantic
  WHERE active = TRUE
  GROUP BY fact_type
), epi AS (
  SELECT
    'episodic'::text AS memory_type,
    COUNT(*) AS total,
    0::bigint AS superseded,
    AVG(GREATEST(EXTRACT(EPOCH FROM (NOW() - happened_at)) / 86400.0, 0.0)) AS avg_days_old,
    0.0::float AS avg_access
  FROM cortana_memory_episodic
  WHERE active = TRUE
)
SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.memory_type), '[]'::json)::text
FROM (
  SELECT * FROM sem
  UNION ALL
  SELECT * FROM epi
) t;
"""
    rows = parse_json_rows(run_psql(sql))
    enriched = []
    for row in rows:
        mtype = str(row.get("memory_type") or "fact")
        avg_days = _safe_float(row.get("avg_days_old"), 0.0)
        avg_access = _safe_float(row.get("avg_access"), 0.0)
        enriched.append(
            {
                **row,
                "half_life_days": "never" if math.isinf(HALF_LIVES_DAYS.get(mtype, HALF_LIVES_DAYS["fact"])) else HALF_LIVES_DAYS.get(mtype, HALF_LIVES_DAYS["fact"]),
                "avg_recency_score": round(recency_score(avg_days, mtype), 6),
                "avg_utility_score": round(utility_score(int(avg_access)), 6),
            }
        )
    print(json.dumps({"distribution": enriched}, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Memory decay + supersession utilities")
    sub = p.add_subparsers(dest="command", required=True)

    sp_stats = sub.add_parser("stats", help="Show decay distribution across memory types")
    sp_stats.set_defaults(func=cmd_stats)

    sp_chain = sub.add_parser("chain", help="Show supersession history")
    sp_chain.add_argument("memory_id", type=int)
    sp_chain.set_defaults(func=cmd_chain)

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    ensure_schema()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
