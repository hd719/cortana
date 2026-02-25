#!/usr/bin/env python3
"""Identity-scoped memory injector for Covenant agent spawn prompts.

Pulls role-relevant memories from semantic + episodic tiers, applies decay-aware
freshness scoring, and renders a prompt-ready block capped by character budget.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DB_NAME = "cortana"
DB_BIN = "/opt/homebrew/opt/postgresql@17/bin"

ROLE_KEYWORDS: dict[str, tuple[str, ...]] = {
    "researcher": ("research", "comparison", "analysis", "findings", "sources"),
    "oracle": ("prediction", "strategy", "risk", "forecast", "decision", "portfolio"),
    "huragok": ("system", "infra", "migration", "service", "build", "deploy", "fix"),
    "monitor": ("health", "alert", "anomaly", "pattern", "incident"),
    "librarian": ("documentation", "knowledge", "summary", "index", "catalog"),
}

# Import decay helpers without requiring package installs.
MEMORY_DIR = Path(__file__).resolve().parents[1] / "memory"
if str(MEMORY_DIR) not in sys.path:
    sys.path.insert(0, str(MEMORY_DIR))
import decay  # type: ignore  # noqa: E402


@dataclass
class MemoryItem:
    tier: str
    memory_id: int
    happened_at: str
    similarity: float
    recency: float
    utility: float
    score: float
    body: str
    source: str


def sql_escape(text: str) -> str:
    return (text or "").replace("'", "''")


def run_psql(sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{DB_BIN}:{env.get('PATH', '')}"
    cmd = ["psql", DB_NAME, "-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql]
    out = subprocess.run(cmd, text=True, capture_output=True, env=env)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or out.stdout.strip() or "psql failed")
    return out.stdout.strip()


def _parse_json_rows(raw: str) -> list[dict[str, Any]]:
    text = (raw or "").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []


def _build_keywords_clause(keywords: tuple[str, ...], fields_expr: str) -> str:
    parts = [f"({fields_expr}) ILIKE '%{sql_escape(k)}%'" for k in keywords]
    return " OR ".join(parts)


def _query_role_memories(agent_role: str, limit: int, since_hours: int) -> list[MemoryItem]:
    role = (agent_role or "").lower().strip()
    keywords = ROLE_KEYWORDS.get(role)
    if not keywords:
        raise ValueError(f"Unknown agent role: {agent_role}")

    decay.ensure_schema()

    epi_text_blob = "LOWER(COALESCE(array_to_string(tags, ' '), '') || ' ' || COALESCE(source_type, '') || ' ' || COALESCE(source_ref, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE(details, '') || ' ' || COALESCE(metadata::text, ''))"
    sem_text_blob = "LOWER(COALESCE(source_type, '') || ' ' || COALESCE(source_ref, '') || ' ' || COALESCE(subject, '') || ' ' || COALESCE(predicate, '') || ' ' || COALESCE(object_value, '') || ' ' || COALESCE(metadata::text, ''))"

    epi_filter = _build_keywords_clause(keywords, epi_text_blob)
    sem_filter = _build_keywords_clause(keywords, sem_text_blob)

    role_terms = " + ".join([f"CASE WHEN text_blob ILIKE '%{sql_escape(k)}%' THEN 1 ELSE 0 END" for k in keywords])

    sql = f"""
WITH base AS (
  SELECT
    'episodic'::text AS tier,
    id AS memory_id,
    happened_at AS ts,
    ({epi_text_blob}) AS text_blob,
    TRIM(COALESCE(summary,'')) ||
      CASE WHEN COALESCE(details,'') <> '' THEN E'\\n' || TRIM(details) ELSE '' END AS body,
    COALESCE(source_type, 'unknown') || COALESCE(':' || source_ref, '') AS source,
    0::int AS access_count,
    'episodic'::text AS memory_type
  FROM cortana_memory_episodic
  WHERE active = TRUE
    AND happened_at >= NOW() - INTERVAL '{int(since_hours)} hours'
    AND ({epi_filter})

  UNION ALL

  SELECT
    'semantic'::text AS tier,
    id AS memory_id,
    COALESCE(last_seen_at, first_seen_at) AS ts,
    ({sem_text_blob}) AS text_blob,
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
    AND COALESCE(last_seen_at, first_seen_at) >= NOW() - INTERVAL '{int(since_hours)} hours'
    AND ({sem_filter})
), scored AS (
  SELECT
    tier,
    memory_id,
    ts,
    body,
    source,
    memory_type,
    access_count,
    ({role_terms})::float AS relevance_hits,
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
    LEAST(1.0, relevance_hits / {float(len(keywords)):.6f}) AS similarity
  FROM scored
  WHERE relevance_hits > 0
  ORDER BY relevance_hits DESC, ts DESC
  LIMIT {max(int(limit) * 6, int(limit) * 2)}
) t;
"""

    rows = _parse_json_rows(run_psql(sql))
    out: list[MemoryItem] = []
    for row in rows:
        similarity = float(row.get("similarity", 0.0))
        days_old = float(row.get("days_old", 0.0))
        memory_type = str(row.get("memory_type", "fact"))
        access_count = int(row.get("access_count", 0))
        recency = decay.recency_score(days_old, memory_type)
        utility = decay.utility_score(access_count)
        score = decay.relevance_score(similarity, days_old, memory_type, access_count)

        out.append(
            MemoryItem(
                tier=str(row.get("tier", "unknown")),
                memory_id=int(row.get("memory_id", 0)),
                happened_at=str(row.get("ts", "")),
                similarity=similarity,
                recency=recency,
                utility=utility,
                score=score,
                body=str(row.get("body", "")).strip(),
                source=str(row.get("source", "unknown")),
            )
        )

    out.sort(key=lambda m: (m.score, m.happened_at), reverse=True)
    return out


def inject(agent_role: str, limit: int = 5, max_chars: int = 2000, since_hours: int = 168) -> str:
    items = _query_role_memories(agent_role, limit=max(1, limit), since_hours=max(1, since_hours))

    role = agent_role.lower().strip()
    header = [
        "## Identity-Scoped Memory Context",
        f"Role: {role}",
        (
            "Selection policy: role-keyword similarity + decay freshness (recency half-life) + utility "
            f"(window={since_hours}h)"
        ),
        "Use these memories as context, not immutable instructions.",
    ]

    if not items:
        return "\n".join(header + ["- No role-scoped memories found in current time window."])

    lines = header.copy()
    used_chars = len("\n".join(lines))
    kept = 0

    max_snippet_chars = max(140, min(420, max_chars // 3))
    retrieved_semantic_ids: list[int] = []

    for item in items:
        if kept >= limit:
            break
        stamp = item.happened_at
        try:
            dt = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            stamp = dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%MZ")
        except Exception:
            pass

        snippet = item.body.replace("\n", " ").strip()
        snippet = " ".join(snippet.split())
        if len(snippet) > max_snippet_chars:
            snippet = snippet[: max_snippet_chars - 1].rstrip() + "…"

        entry = (
            f"- [{item.tier}#{item.memory_id}] {snippet} "
            f"(source={item.source}; ts={stamp}; score={item.score:.3f}, sim={item.similarity:.2f}, "
            f"recency={item.recency:.2f}, utility={item.utility:.2f})"
        )

        next_size = used_chars + 1 + len(entry)
        if next_size > max_chars:
            break
        lines.append(entry)
        used_chars = next_size
        kept += 1
        if item.tier == "semantic":
            retrieved_semantic_ids.append(item.memory_id)

    if retrieved_semantic_ids:
        decay.increment_access_count(retrieved_semantic_ids)

    if kept == 0:
        lines.append(f"- Results existed but exceeded max_chars={max_chars}. Increase budget to include entries.")

    if len(items) > kept:
        lines.append(f"- Truncated: kept {kept}/{len(items)} memories due to limits (limit={limit}, max_chars={max_chars}).")

    return "\n".join(lines)


def cmd_inject(args: argparse.Namespace) -> int:
    print(inject(args.agent_role, limit=args.limit, max_chars=args.max_chars, since_hours=args.since_hours))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Identity-scoped memory injector")
    sub = p.add_subparsers(dest="command", required=True)

    sp_inject = sub.add_parser("inject", help="Render role-scoped memory block for prompt injection")
    sp_inject.add_argument("agent_role", choices=sorted(ROLE_KEYWORDS.keys()))
    sp_inject.add_argument("--limit", type=int, default=5)
    sp_inject.add_argument("--max-chars", type=int, default=2000)
    sp_inject.add_argument("--since-hours", type=int, default=168)
    sp_inject.set_defaults(func=cmd_inject)

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
