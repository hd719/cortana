#!/usr/bin/env python3
"""
Sub-Agent Completion Auto-Sync Enforcer

Purpose:
- Validate sub-agent completion output quality
- Match completion to ready/in_progress tasks in cortana_tasks
- Auto-close matched tasks with outcome summary
- Create a completed task if no match exists
- Emit JSON decision logs to stdout

Usage examples:
  python3 tools/task-board/auto_sync_enforcer.py \
    --label huragok-tone-and-sync \
    --result "Implemented tone sentinel and auto sync enforcer; tests pass."

  python3 tools/task-board/auto_sync_enforcer.py \
    --label monitor-healthcheck \
    --result-file /tmp/subagent_result.txt \
    --pretty
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PSQL_BIN_PATH = "/opt/homebrew/opt/postgresql@17/bin"
DB_NAME = "cortana"

EVIDENCE_MARKERS = {
    "implemented",
    "updated",
    "added",
    "fixed",
    "refactored",
    "tested",
    "validated",
    "committed",
    "pushed",
    "created",
    "ran",
    "query",
    "sql",
    "python",
}

VAGUE_PATTERNS = [
    r"^\s*done\.?\s*$",
    r"^\s*completed\.?\s*$",
    r"^\s*all good\.?\s*$",
    r"^\s*fixed it\.?\s*$",
    r"^\s*handled\.?\s*$",
]


def emit(event: str, payload: dict[str, Any], pretty: bool = False) -> None:
    doc = {"event": event, "ts": datetime.now(timezone.utc).isoformat(), **payload}
    if pretty:
        print(json.dumps(doc, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(doc, ensure_ascii=False))


def run_sql(query: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{PSQL_BIN_PATH}:{env.get('PATH', '')}"
    proc = subprocess.run(
        ["psql", DB_NAME, "-X", "-t", "-A", "-c", query],
        capture_output=True,
        text=True,
        env=env,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "psql failed")
    return proc.stdout.strip()


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def tokenize(label: str) -> list[str]:
    return [tok for tok in re.split(r"[^a-zA-Z0-9]+", label.lower()) if len(tok) >= 3]


def validate_result(result: str) -> dict[str, Any]:
    norm = normalize(result)
    word_count = len(norm.split()) if norm else 0

    reasons: list[str] = []
    score = 1.0

    if not norm:
        reasons.append("empty")
        score -= 1.0

    if any(re.search(pat, norm, re.IGNORECASE) for pat in VAGUE_PATTERNS):
        reasons.append("vague_one_liner")
        score -= 0.6

    if word_count < 8:
        reasons.append("too_short")
        score -= 0.35

    evidence_hits = sum(1 for m in EVIDENCE_MARKERS if m in norm)
    has_paths_or_commands = bool(re.search(r"(/\w|\.py\b|\.md\b|git\s+|python3\s+|SELECT\s+|UPDATE\s+)", result, re.IGNORECASE))

    if evidence_hits == 0 and not has_paths_or_commands:
        reasons.append("no_evidence_markers")
        score -= 0.5

    valid = score >= 0.5 and "empty" not in reasons
    return {
        "valid": valid,
        "score": max(0.0, round(score, 4)),
        "reasons": reasons,
        "word_count": word_count,
        "evidence_hits": evidence_hits,
        "has_paths_or_commands": has_paths_or_commands,
    }


def fetch_candidates(label: str) -> list[dict[str, Any]]:
    tokens = tokenize(label)
    like_clauses = [f"LOWER(title) LIKE '%{t}%' OR LOWER(COALESCE(description,'')) LIKE '%{t}%'" for t in tokens]
    token_filter = " OR ".join(like_clauses) if like_clauses else "TRUE"

    query = f"""
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
    FROM (
      SELECT id, title, description, status, assigned_to, priority, created_at
      FROM cortana_tasks
      WHERE status IN ('ready', 'in_progress')
        AND ({token_filter}
             OR LOWER(COALESCE(assigned_to,'')) LIKE '%' || {sql_quote(label.lower())} || '%'
             OR LOWER(COALESCE(metadata::text,'')) LIKE '%' || {sql_quote(label.lower())} || '%')
      ORDER BY priority ASC, created_at DESC
      LIMIT 50
    ) t;
    """
    raw = run_sql(query)
    if not raw:
        return []
    return json.loads(raw)


def similarity_score(label: str, task: dict[str, Any]) -> float:
    l = normalize(label)
    title = normalize(task.get("title") or "")
    desc = normalize(task.get("description") or "")

    title_ratio = difflib.SequenceMatcher(a=l, b=title).ratio()
    desc_ratio = difflib.SequenceMatcher(a=l, b=desc).ratio()

    token_hits = sum(1 for t in tokenize(label) if t in title or t in desc)
    token_bonus = min(0.3, token_hits * 0.06)

    return max(title_ratio, desc_ratio * 0.8) + token_bonus


def summarize_result(result: str, max_len: int = 500) -> str:
    cleaned = re.sub(r"\s+", " ", result.strip())
    if len(cleaned) <= max_len:
        return cleaned
    return cleaned[: max_len - 3] + "..."


def update_task_done(task_id: int, summary: str, label: str) -> dict[str, Any]:
    query = f"""
    UPDATE cortana_tasks
    SET status = 'completed',
        completed_at = NOW(),
        outcome = {sql_quote(summary)},
        metadata = COALESCE(metadata, '{{}}'::jsonb) ||
                   jsonb_build_object('auto_sync', true, 'subagent_label', {sql_quote(label)})
    WHERE id = {task_id}
    RETURNING row_to_json(cortana_tasks);
    """
    raw = run_sql(query)
    if not raw:
        raise RuntimeError(f"Update failed for task {task_id}")
    return json.loads(raw)


def create_done_task(label: str, summary: str) -> dict[str, Any]:
    title = f"Sub-agent completion: {label}"
    query = f"""
    INSERT INTO cortana_tasks
      (source, title, description, priority, status, auto_executable, outcome, completed_at, metadata, assigned_to)
    VALUES
      ('subagent_auto_sync',
       {sql_quote(title)},
       {sql_quote('Auto-created from sub-agent completion sync.')},
       3,
       'completed',
       FALSE,
       {sql_quote(summary)},
       NOW(),
       jsonb_build_object('auto_sync', true, 'created_from_label', {sql_quote(label)}),
       {sql_quote(label)})
    RETURNING row_to_json(cortana_tasks);
    """
    raw = run_sql(query)
    if not raw:
        raise RuntimeError("Insert failed for fallback completed task")
    return json.loads(raw)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Auto-sync sub-agent completion into cortana_tasks.")
    parser.add_argument("--label", required=True, help="Sub-agent label (e.g., huragok-tone-and-sync)")
    grp = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--result", help="Completion result text")
    grp.add_argument("--result-file", type=Path, help="Path to completion result text file")
    parser.add_argument("--min-match", type=float, default=0.38, help="Minimum similarity score to match existing task")
    parser.add_argument("--pretty", action="store_true", help="Pretty JSON output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result_text = args.result if args.result is not None else args.result_file.read_text()

    validation = validate_result(result_text)
    emit("auto_sync_validation", {"label": args.label, **validation}, pretty=args.pretty)

    if not validation["valid"]:
        emit(
            "auto_sync_rejected",
            {
                "label": args.label,
                "reason": "Completion result failed validation",
                "validation": validation,
            },
            pretty=args.pretty,
        )
        return 3

    candidates = fetch_candidates(args.label)
    scored = [
        {
            "task": task,
            "score": round(similarity_score(args.label, task), 4),
        }
        for task in candidates
    ]
    scored.sort(key=lambda x: x["score"], reverse=True)

    emit(
        "auto_sync_match_scan",
        {
            "label": args.label,
            "candidate_count": len(scored),
            "top_candidates": [
                {"id": c["task"]["id"], "title": c["task"].get("title"), "score": c["score"]}
                for c in scored[:5]
            ],
        },
        pretty=args.pretty,
    )

    summary = summarize_result(result_text)

    try:
        if scored and scored[0]["score"] >= args.min_match:
            chosen = scored[0]["task"]
            updated = update_task_done(chosen["id"], summary, args.label)
            emit(
                "auto_sync_task_updated",
                {
                    "label": args.label,
                    "matched_task_id": chosen["id"],
                    "match_score": scored[0]["score"],
                    "status": "completed",
                    "task": updated,
                },
                pretty=args.pretty,
            )
        else:
            created = create_done_task(args.label, summary)
            emit(
                "auto_sync_task_created",
                {
                    "label": args.label,
                    "reason": "no_match_found",
                    "status": "completed",
                    "task": created,
                },
                pretty=args.pretty,
            )
    except Exception as exc:  # pragma: no cover
        emit("auto_sync_error", {"label": args.label, "error": str(exc)}, pretty=args.pretty)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
