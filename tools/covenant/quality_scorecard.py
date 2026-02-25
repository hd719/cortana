#!/usr/bin/env python3
"""Agent Output Quality Scorecards.

Scores completed tasks against execution quality criteria and stores results in
cortana_quality_scores.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
from typing import Any

DB_NAME = "cortana"
DB_BIN = "/opt/homebrew/opt/postgresql@17/bin"

CRITERIA_POINTS = 20

ROLE_KEYWORDS: dict[str, tuple[str, ...]] = {
    "huragok": ("infra", "migration", "build", "tool", "automation", "service", "devops"),
    "researcher": ("research", "compare", "analysis", "findings", "sources"),
    "librarian": ("docs", "documentation", "readme", "runbook", "guide"),
    "oracle": ("forecast", "risk", "strategy", "decision", "model"),
    "monitor": ("monitor", "alert", "health", "watch", "scorecard", "quality"),
}


def sql_escape(text: str) -> str:
    return (text or "").replace("'", "''")


def run_psql(sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{DB_BIN}:{env.get('PATH', '')}"
    cmd = ["psql", DB_NAME, "-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "|", "-c", sql]
    out = subprocess.run(cmd, text=True, capture_output=True, env=env)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or out.stdout.strip() or "psql failed")
    return out.stdout.strip()


def run_git(args: list[str]) -> str:
    out = subprocess.run(["git", *args], text=True, capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or out.stdout.strip() or f"git {' '.join(args)} failed")
    return out.stdout.strip()


def parse_row(raw: str) -> list[str]:
    line = next((ln for ln in (raw or "").splitlines() if ln.strip()), "")
    return line.split("|") if line else []


def infer_agent_role(*texts: str) -> str:
    blob = " ".join(t for t in texts if t).lower()
    if not blob:
        return "unknown"
    scores: dict[str, int] = {}
    for role, keywords in ROLE_KEYWORDS.items():
        hit = sum(1 for kw in keywords if kw in blob)
        if hit:
            scores[role] = hit
    if not scores:
        return "unknown"
    return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[0][0]


def get_task(task_id: int) -> dict[str, Any]:
    sql = f"""
SELECT id, status, title, description, execution_plan, COALESCE(outcome,''), COALESCE(assigned_to,''), COALESCE(metadata::text,'{{}}')
FROM cortana_tasks
WHERE id = {int(task_id)};
"""
    row = parse_row(run_psql(sql))
    if not row:
        raise ValueError(f"Task {task_id} not found")

    metadata: dict[str, Any] = {}
    try:
        metadata = json.loads(row[7]) if len(row) > 7 and row[7] else {}
    except Exception:
        metadata = {}

    return {
        "id": int(row[0]),
        "status": row[1],
        "title": row[2],
        "description": row[3],
        "execution_plan": row[4],
        "outcome": row[5],
        "assigned_to": row[6],
        "metadata": metadata,
    }


def _title_tokens(title: str) -> list[str]:
    tokens = re.findall(r"[a-z0-9]+", (title or "").lower())
    return [t for t in tokens if len(t) >= 5]


def _related_commit_hashes(task_id: int, title: str, max_commits: int = 300) -> list[str]:
    log = run_git(["log", f"-n{max_commits}", "--pretty=format:%H|%s|%b"])
    hashes: list[str] = []
    title_words = _title_tokens(title)

    for line in log.splitlines():
        parts = line.split("|", 2)
        if len(parts) < 2:
            continue
        commit_hash = parts[0]
        msg = " ".join(parts[1:]).lower()

        explicit = any(
            token in msg
            for token in (
                f"task {task_id}",
                f"task#{task_id}",
                f"#{task_id}",
                f"id {task_id}",
                f"id:{task_id}",
            )
        )
        title_hits = sum(1 for token in title_words if token in msg)

        if explicit or title_hits >= 2:
            hashes.append(commit_hash)

    return hashes


def _changed_files_for_commits(commits: list[str]) -> list[str]:
    if not commits:
        return []
    files: list[str] = []
    for commit in commits:
        out = run_git(["show", "--name-only", "--pretty=format:", commit])
        files.extend([ln.strip() for ln in out.splitlines() if ln.strip()])
    return sorted(set(files))


def _compile_python_files(files: list[str]) -> tuple[bool, list[str], str]:
    py_files = [f for f in files if f.endswith(".py") and os.path.exists(f)]
    if not py_files:
        return True, [], "No Python files changed in related commits."

    failed: list[str] = []
    last_error = ""
    for pyf in py_files:
        out = subprocess.run(["python3", "-m", "py_compile", pyf], text=True, capture_output=True)
        if out.returncode != 0:
            failed.append(pyf)
            last_error = out.stderr.strip() or out.stdout.strip()
    if failed:
        return False, failed, last_error
    return True, py_files, "All changed Python files compile."


def score(task_id: int) -> dict[str, Any]:
    task = get_task(task_id)
    commits = _related_commit_hashes(task_id, task["title"])
    changed_files = _changed_files_for_commits(commits)

    docs_required = bool(re.search(r"\b(doc|docs|documentation|readme|runbook|guide)\b", task["execution_plan"].lower()))
    docs_present = any(path.startswith("docs/") or path.lower().endswith(".md") for path in changed_files)

    compile_ok, compile_targets_or_failed, compile_details = _compile_python_files(changed_files)

    criteria = {
        "task_marked_done": {
            "passed": task["status"] == "done",
            "points": CRITERIA_POINTS if task["status"] == "done" else 0,
            "details": f"status={task['status']}",
        },
        "git_commit_made": {
            "passed": len(commits) > 0,
            "points": CRITERIA_POINTS if commits else 0,
            "details": f"commits={commits[:5]}",
        },
        "docs_created_if_required": {
            "passed": (not docs_required) or docs_present,
            "points": CRITERIA_POINTS if ((not docs_required) or docs_present) else 0,
            "details": f"docs_required={docs_required}, docs_present={docs_present}",
        },
        "python_compile_check": {
            "passed": compile_ok,
            "points": CRITERIA_POINTS if compile_ok else 0,
            "details": compile_details,
            "targets": compile_targets_or_failed,
        },
        "outcome_populated": {
            "passed": bool(task["outcome"].strip()),
            "points": CRITERIA_POINTS if task["outcome"].strip() else 0,
            "details": "outcome present" if task["outcome"].strip() else "outcome empty",
        },
    }

    total = sum(item["points"] for item in criteria.values())
    agent_role = task["assigned_to"] or infer_agent_role(task["title"], task["description"], task["execution_plan"], task["outcome"])

    insert_sql = f"""
INSERT INTO cortana_quality_scores (task_id, agent_role, score, criteria_results, scored_at)
VALUES (
  {task_id},
  '{sql_escape(agent_role)}',
  {total},
  '{sql_escape(json.dumps(criteria))}'::jsonb,
  NOW()
)
RETURNING id, scored_at;
"""
    stored = parse_row(run_psql(insert_sql))

    return {
        "task_id": task_id,
        "agent_role": agent_role,
        "score": total,
        "criteria_results": criteria,
        "commits_considered": commits,
        "changed_files": changed_files,
        "record_id": int(stored[0]) if stored else None,
        "scored_at": stored[1] if len(stored) > 1 else None,
    }


def _period_to_interval(period: str) -> str:
    if re.fullmatch(r"\d+[smhdw]", period.strip()):
        count = int(period[:-1])
        unit_map = {"s": "seconds", "m": "minutes", "h": "hours", "d": "days", "w": "weeks"}
        return f"{count} {unit_map[period[-1]]}"
    raise ValueError("Invalid period format. Use like 7d, 24h, 30m.")


def report(period: str = "7d") -> dict[str, Any]:
    interval = _period_to_interval(period)
    sql = f"""
SELECT
  agent_role,
  COUNT(*) AS samples,
  ROUND(AVG(score)::numeric, 2) AS avg_score,
  MIN(score) AS min_score,
  MAX(score) AS max_score
FROM cortana_quality_scores
WHERE scored_at >= NOW() - INTERVAL '{sql_escape(interval)}'
GROUP BY agent_role
ORDER BY avg_score DESC, samples DESC;
"""
    raw = run_psql(sql)
    rows = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        role, samples, avg_score, min_score, max_score = line.split("|")
        rows.append(
            {
                "agent_role": role,
                "samples": int(samples),
                "avg_score": float(avg_score),
                "min_score": int(min_score),
                "max_score": int(max_score),
            }
        )
    return {"period": period, "results": rows}


def trends(period: str = "7d") -> dict[str, Any]:
    interval = _period_to_interval(period)
    sql = f"""
WITH recent AS (
  SELECT agent_role, AVG(score) AS avg_score, COUNT(*) AS samples
  FROM cortana_quality_scores
  WHERE scored_at >= NOW() - INTERVAL '{sql_escape(interval)}'
  GROUP BY agent_role
),
previous AS (
  SELECT agent_role, AVG(score) AS avg_score, COUNT(*) AS samples
  FROM cortana_quality_scores
  WHERE scored_at >= NOW() - (INTERVAL '{sql_escape(interval)}' * 2)
    AND scored_at < NOW() - INTERVAL '{sql_escape(interval)}'
  GROUP BY agent_role
)
SELECT
  COALESCE(r.agent_role, p.agent_role) AS agent_role,
  COALESCE(r.avg_score, 0) AS recent_avg,
  COALESCE(p.avg_score, 0) AS previous_avg,
  COALESCE(r.samples, 0) AS recent_samples,
  COALESCE(p.samples, 0) AS previous_samples,
  (COALESCE(r.avg_score, 0) - COALESCE(p.avg_score, 0)) AS delta
FROM recent r
FULL OUTER JOIN previous p ON p.agent_role = r.agent_role
ORDER BY delta DESC;
"""
    raw = run_psql(sql)
    rows = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        role, recent_avg, previous_avg, recent_samples, previous_samples, delta = line.split("|")
        delta_f = float(delta)
        rows.append(
            {
                "agent_role": role,
                "recent_avg": round(float(recent_avg), 2),
                "previous_avg": round(float(previous_avg), 2),
                "recent_samples": int(recent_samples),
                "previous_samples": int(previous_samples),
                "delta": round(delta_f, 2),
                "trend": "improving" if delta_f > 0 else ("declining" if delta_f < 0 else "flat"),
            }
        )

    generated_at = dt.datetime.now(dt.timezone.utc).isoformat()
    return {"period": period, "generated_at": generated_at, "results": rows}


def cmd_score(args: argparse.Namespace) -> int:
    result = score(args.task_id)
    print(json.dumps(result, indent=2))
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    result = report(period=args.period)
    print(json.dumps(result, indent=2))
    return 0


def cmd_trends(args: argparse.Namespace) -> int:
    result = trends(period=args.period)
    print(json.dumps(result, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Agent output quality scoring")
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("score", help="Score one task and store result")
    sp.add_argument("task_id", type=int)
    sp.set_defaults(func=cmd_score)

    rp = sub.add_parser("report", help="Aggregate quality scores by role")
    rp.add_argument("--period", default="7d", help="Lookback period like 7d, 24h")
    rp.set_defaults(func=cmd_report)

    tp = sub.add_parser("trends", help="Compare recent vs previous period")
    tp.add_argument("--period", default="7d", help="Window period like 7d, 24h")
    tp.set_defaults(func=cmd_trends)

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
