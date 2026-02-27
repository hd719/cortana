#!/usr/bin/env python3
"""Agent Feedback Compiler (AFC).

Compiles agent-specific lessons from correction/task history and provides
query/injection interfaces for spawn prompt enrichment.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from typing import Iterable

DB_NAME = "cortana"
DB_BIN = "/opt/homebrew/opt/postgresql@17/bin"

AGENT_KEYWORDS: dict[str, tuple[str, ...]] = {
    "huragok": ("huragok", "implement", "build", "code", "migration", "infra", "branch", "git"),
    "researcher": ("researcher", "research", "sources", "evidence", "findings", "synthesis"),
    "librarian": ("librarian", "docs", "documentation", "readme", "spec", "runbook"),
    "oracle": ("oracle", "forecast", "risk", "strategy", "decision", "model"),
    "monitor": ("monitor", "monitoring", "alert", "anomaly", "health", "watchdog"),
}

TASK_ISSUE_PATTERNS = (
    "issue",
    "problem",
    "failed",
    "failure",
    "regression",
    "backlog",
    "bug",
    "retry",
)


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


def classify_agent(text: str) -> str:
    lowered = (text or "").lower()
    hits: dict[str, int] = {}
    for role, words in AGENT_KEYWORDS.items():
        score = sum(1 for w in words if w in lowered)
        if score:
            hits[role] = score
    if not hits:
        return "all"
    return sorted(hits.items(), key=lambda kv: kv[1], reverse=True)[0][0]


def normalize_lesson(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", (text or "").strip())
    return cleaned[:800]


def upsert_lesson(
    *,
    agent_role: str,
    feedback_text: str,
    confidence: float,
    source_feedback_id: int | None = None,
    source_task_id: int | None = None,
) -> None:
    lesson = normalize_lesson(feedback_text)
    if not lesson:
        return

    source_feedback_sql = "NULL" if source_feedback_id is None else str(source_feedback_id)
    source_task_sql = "NULL" if source_task_id is None else str(source_task_id)

    sql = f"""
INSERT INTO cortana_agent_feedback
  (agent_role, feedback_text, source_feedback_id, source_task_id, confidence, active, updated_at)
VALUES
  ('{sql_escape(agent_role)}', '{sql_escape(lesson)}', {source_feedback_sql}, {source_task_sql}, {confidence:.2f}, TRUE, NOW())
ON CONFLICT (agent_role, lower(feedback_text), active) WHERE active = TRUE
DO UPDATE
SET confidence = GREATEST(cortana_agent_feedback.confidence, EXCLUDED.confidence),
    source_feedback_id = COALESCE(EXCLUDED.source_feedback_id, cortana_agent_feedback.source_feedback_id),
    source_task_id = COALESCE(EXCLUDED.source_task_id, cortana_agent_feedback.source_task_id),
    updated_at = NOW();
"""
    run_psql(sql)


def _parse_rows(raw: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in (raw or "").splitlines():
        if not line.strip():
            continue
        rows.append(line.split("|"))
    return rows


def compile_from_feedback() -> int:
    sql = """
SELECT id, feedback_type, context, lesson, applied
FROM cortana_feedback
ORDER BY id DESC
LIMIT 300;
"""
    rows = _parse_rows(run_psql(sql))
    inserted = 0

    for row in rows:
        feedback_id = int(row[0])
        feedback_type = row[1] if len(row) > 1 else ""
        context = row[2] if len(row) > 2 else ""
        lesson = row[3] if len(row) > 3 else ""
        applied = (row[4] if len(row) > 4 else "").lower() in ("t", "true", "1")

        if not lesson:
            continue

        combined = f"{feedback_type} {context} {lesson}"
        role = classify_agent(combined)
        confidence = 0.88 if applied else 0.72
        upsert_lesson(
            agent_role=role,
            feedback_text=lesson,
            confidence=confidence,
            source_feedback_id=feedback_id,
        )
        inserted += 1

    return inserted


def compile_from_tasks() -> int:
    pattern_sql = " OR ".join(
        [f"COALESCE(outcome,'') ILIKE '%{p}%'" for p in TASK_ISSUE_PATTERNS]
        + [f"COALESCE(description,'') ILIKE '%{p}%'" for p in TASK_ISSUE_PATTERNS]
    )

    sql = f"""
SELECT id, title, description, status, outcome
FROM cortana_tasks
WHERE status = 'failed'
   OR (status = 'completed' AND ({pattern_sql}))
ORDER BY id DESC
LIMIT 300;
"""

    rows = _parse_rows(run_psql(sql))
    inserted = 0

    for row in rows:
        task_id = int(row[0])
        title = row[1] if len(row) > 1 else ""
        description = row[2] if len(row) > 2 else ""
        status = row[3] if len(row) > 3 else ""
        outcome = row[4] if len(row) > 4 else ""

        combined = f"{title} {description} {outcome}"
        role = classify_agent(combined)

        if status == "failed":
            lesson = f"Avoid repeat failure pattern from task '{title}': {outcome or description or 'Investigate root cause before retry.'}"
            confidence = 0.82
        else:
            lesson = f"For task '{title}', preserve this learning from issues encountered: {outcome or description}"
            confidence = 0.76

        upsert_lesson(
            agent_role=role,
            feedback_text=lesson,
            confidence=confidence,
            source_task_id=task_id,
        )
        inserted += 1

    return inserted


def cmd_compile(_: argparse.Namespace) -> int:
    f_count = compile_from_feedback()
    t_count = compile_from_tasks()
    print(json.dumps({"compiled_from_feedback": f_count, "compiled_from_tasks": t_count, "total": f_count + t_count}))
    return 0


def query_lessons(agent_role: str, limit: int = 5) -> list[dict[str, str | int | float]]:
    role = sql_escape(agent_role.lower())
    sql = f"""
SELECT id, agent_role, feedback_text, confidence, created_at
FROM cortana_agent_feedback
WHERE active = TRUE
  AND (agent_role = '{role}' OR agent_role = 'all')
ORDER BY confidence DESC, updated_at DESC
LIMIT {int(limit)};
"""
    rows = _parse_rows(run_psql(sql))
    out: list[dict[str, str | int | float]] = []
    for row in rows:
        out.append(
            {
                "id": int(row[0]),
                "agent_role": row[1],
                "feedback_text": row[2],
                "confidence": float(row[3]),
                "created_at": row[4],
            }
        )
    return out


def cmd_query(args: argparse.Namespace) -> int:
    items = query_lessons(args.agent_role, limit=args.limit)
    print(json.dumps(items, indent=2))
    return 0


def build_injection_block(agent_role: str, limit: int = 5) -> str:
    items = query_lessons(agent_role, limit=limit)
    if not items:
        return "## Agent Feedback Lessons\n- No active lessons available for this role yet."

    lines = ["## Agent Feedback Lessons", "These are curated lessons from prior corrections and task outcomes. Apply them in this run."]
    for i, item in enumerate(items, start=1):
        lines.append(f"{i}. {item['feedback_text']} (confidence={item['confidence']:.2f})")
    return "\n".join(lines)


def cmd_inject(args: argparse.Namespace) -> int:
    print(build_injection_block(args.agent_role, limit=args.limit))
    return 0


def cmd_deactivate(args: argparse.Namespace) -> int:
    run_psql(
        f"UPDATE cortana_agent_feedback SET active = FALSE, updated_at = NOW() WHERE id = {int(args.id)};"
    )
    print(json.dumps({"deactivated": int(args.id)}))
    return 0


def cmd_stats(_: argparse.Namespace) -> int:
    sql = """
SELECT agent_role, COUNT(*)
FROM cortana_agent_feedback
WHERE active = TRUE
GROUP BY agent_role
ORDER BY COUNT(*) DESC, agent_role ASC;
"""
    rows = _parse_rows(run_psql(sql))
    payload = [{"agent_role": r[0], "active_lessons": int(r[1])} for r in rows]
    print(json.dumps(payload, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Agent Feedback Compiler (AFC)")
    sub = p.add_subparsers(dest="command", required=True)

    sp_compile = sub.add_parser("compile", help="Compile lessons from cortana_feedback and cortana_tasks")
    sp_compile.set_defaults(func=cmd_compile)

    sp_query = sub.add_parser("query", help="Query top active lessons for an agent role")
    sp_query.add_argument("agent_role", help="Agent role, e.g. huragok/researcher/librarian/oracle/monitor")
    sp_query.add_argument("--limit", type=int, default=5)
    sp_query.set_defaults(func=cmd_query)

    sp_inject = sub.add_parser("inject", help="Render spawn-ready instruction block for an agent role")
    sp_inject.add_argument("agent_role", help="Agent role")
    sp_inject.add_argument("--limit", type=int, default=5)
    sp_inject.set_defaults(func=cmd_inject)

    sp_deactivate = sub.add_parser("deactivate", help="Deactivate a lesson by id")
    sp_deactivate.add_argument("id", type=int)
    sp_deactivate.set_defaults(func=cmd_deactivate)

    sp_stats = sub.add_parser("stats", help="Show active lesson counts per agent role")
    sp_stats.set_defaults(func=cmd_stats)

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
