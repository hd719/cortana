#!/usr/bin/env python3
"""Automated reflection + correction learning loop.

Capabilities:
1) Post-task reflection for recently completed tasks
2) Rule extraction from cortana_feedback with confidence scoring
3) Auto-apply high-confidence rules to policy files
4) Repeated correction rate KPI tracking + reflection journal
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path("/Users/hd/clawd")
DB_PATH = "/opt/homebrew/opt/postgresql@17/bin"

TARGET_FILES = {
    "preference": ROOT / "MEMORY.md",
    "fact": ROOT / "MEMORY.md",
    "behavior": ROOT / "AGENTS.md",
    "tone": ROOT / "SOUL.md",
    "correction": ROOT / "AGENTS.md",
}

FAILURE_HINTS = ("fail", "error", "broken", "backlog", "retry", "regress", "didn't", "did not")
NEAR_MISS_HINTS = ("almost", "near", "manual", "had to", "would have", "close call")


@dataclass
class ReflectionRule:
    feedback_type: str
    rule_text: str
    evidence_count: int
    first_seen: str
    last_seen: str
    confidence: float


def _sql_escape(text: str) -> str:
    return text.replace("'", "''")


def _run_psql(sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{DB_PATH}:{env.get('PATH', '')}"
    cmd = ["psql", "cortana", "-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql]
    res = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or "psql failed")
    return res.stdout.strip()


def _fetch_json(sql: str) -> list[dict[str, Any]]:
    wrapped = f"SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ({sql}) t;"
    raw = _run_psql(wrapped)
    return json.loads(raw) if raw else []


def _write_journal(run_id: int, entry_type: str, title: str, body: str = "", metadata: dict[str, Any] | None = None) -> None:
    meta = json.dumps(metadata or {})
    _run_psql(
        "INSERT INTO cortana_reflection_journal (run_id, entry_type, title, body, metadata) "
        f"VALUES ({run_id}, '{_sql_escape(entry_type)}', '{_sql_escape(title)}', '{_sql_escape(body)}', '{_sql_escape(meta)}'::jsonb);"
    )


def _start_run(trigger_source: str, mode: str, window_days: int) -> int:
    rid = _run_psql(
        "INSERT INTO cortana_reflection_runs (trigger_source, mode, window_days) "
        f"VALUES ('{_sql_escape(trigger_source)}', '{_sql_escape(mode)}', {window_days}) RETURNING id;"
    )
    return int(rid)


def _classify_task(task: dict[str, Any]) -> tuple[str, float, str]:
    text = " ".join(
        [
            str(task.get("title") or ""),
            str(task.get("description") or ""),
            str(task.get("outcome") or ""),
        ]
    ).lower()

    if any(h in text for h in FAILURE_HINTS):
        return "failure", 0.9, "Task outcome contains failure indicators."
    if any(h in text for h in NEAR_MISS_HINTS):
        return "near_miss", 0.7, "Task outcome indicates near-miss/manual recovery."
    if str(task.get("status") or "") == "completed":
        return "success", 0.4, "Task completed without explicit failure markers."
    return "unknown", 0.2, "Insufficient outcome signal."


def _task_reflection(run_id: int, explicit_task_id: int | None = None) -> int:
    where = f"t.id = {explicit_task_id}" if explicit_task_id else "t.status IN ('completed','cancelled') AND t.completed_at > NOW() - INTERVAL '7 days'"
    tasks = _fetch_json(
        "SELECT t.id, t.title, t.description, t.status, t.outcome, t.completed_at "
        "FROM cortana_tasks t "
        "LEFT JOIN cortana_task_reflections r ON r.task_id = t.id "
        f"WHERE {where} AND r.task_id IS NULL "
        "ORDER BY t.completed_at DESC NULLS LAST LIMIT 100"
    )

    reflected = 0
    for task in tasks:
        outcome_type, signal, reason = _classify_task(task)
        lesson = f"{reason} Lesson: reinforce planning + validation around '{task.get('title', 'task')}'."
        evidence = json.dumps(
            {
                "status": task.get("status"),
                "outcome": task.get("outcome"),
                "completed_at": task.get("completed_at"),
            }
        )
        _run_psql(
            "INSERT INTO cortana_task_reflections (task_id, outcome_type, signal_score, lesson, evidence) VALUES "
            f"({int(task['id'])}, '{outcome_type}', {signal:.2f}, '{_sql_escape(lesson)}', '{_sql_escape(evidence)}'::jsonb)"
            " ON CONFLICT (task_id) DO NOTHING;"
        )
        if outcome_type in {"failure", "near_miss"}:
            _write_journal(
                run_id,
                "task_reflection",
                f"Task #{task['id']} reflected as {outcome_type}",
                lesson,
                {"task_id": task["id"], "signal_score": signal},
            )
        reflected += 1
    return reflected


def _normalize_rule_text(lesson: str) -> str:
    cleaned = re.sub(r"\s+", " ", lesson.strip())
    return cleaned[:400]


def _extract_rules(window_days: int) -> tuple[list[ReflectionRule], float, int]:
    rows = _fetch_json(
        "SELECT feedback_type, lesson, COUNT(*)::int AS evidence_count, "
        "MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen "
        "FROM cortana_feedback "
        f"WHERE timestamp > NOW() - INTERVAL '{window_days} days' "
        "GROUP BY feedback_type, lesson ORDER BY evidence_count DESC, last_seen DESC"
    )
    total_feedback = sum(int(r["evidence_count"]) for r in rows) or 1
    repeats = sum(max(0, int(r["evidence_count"]) - 1) for r in rows)
    repeated_rate = round((repeats / total_feedback) * 100, 2)

    rules: list[ReflectionRule] = []
    for r in rows:
        n = int(r["evidence_count"])
        recency_bonus = 0.15 if r["last_seen"] and str(r["last_seen"])[:10] == datetime.now(timezone.utc).date().isoformat() else 0.05
        confidence = min(0.98, 0.35 + 0.22 * math.log(n + 1) + recency_bonus)
        rules.append(
            ReflectionRule(
                feedback_type=r["feedback_type"],
                rule_text=_normalize_rule_text(r["lesson"]),
                evidence_count=n,
                first_seen=str(r["first_seen"]),
                last_seen=str(r["last_seen"]),
                confidence=round(confidence, 3),
            )
        )

    return rules, repeated_rate, total_feedback


def _ensure_managed_section(path: Path) -> str:
    text = path.read_text() if path.exists() else ""
    start = "<!-- AUTO_REFLECTION_RULES:START -->"
    end = "<!-- AUTO_REFLECTION_RULES:END -->"
    if start in text and end in text:
        return text
    block = (
        "\n\n## Auto-Reflected Rules\n"
        f"{start}\n"
        "- (managed by tools/reflection/reflect.py)\n"
        f"{end}\n"
    )
    return text + block


def _apply_rule_to_file(path: Path, rule: ReflectionRule) -> None:
    text = _ensure_managed_section(path)
    start = "<!-- AUTO_REFLECTION_RULES:START -->"
    end = "<!-- AUTO_REFLECTION_RULES:END -->"
    entry = f"- [{rule.feedback_type}] {rule.rule_text} (conf={rule.confidence:.3f}, n={rule.evidence_count})"

    pre, rest = text.split(start, 1)
    body, post = rest.split(end, 1)
    lines = [ln.rstrip() for ln in body.strip().splitlines() if ln.strip()]
    if entry not in lines:
        lines.append(entry)
    new_body = "\n" + "\n".join(lines) + "\n"
    path.write_text(pre + start + new_body + end + post)


def _upsert_rules(run_id: int, rules: list[ReflectionRule], auto_threshold: float) -> int:
    applied = 0
    for rule in rules:
        target = TARGET_FILES.get(rule.feedback_type, ROOT / "AGENTS.md")
        meta = json.dumps({"first_seen": rule.first_seen, "last_seen": rule.last_seen})
        _run_psql(
            "INSERT INTO cortana_reflection_rules (feedback_type, rule_text, confidence, evidence_count, first_seen, last_seen, status, target_file, source_run_id, metadata) "
            f"VALUES ('{_sql_escape(rule.feedback_type)}', '{_sql_escape(rule.rule_text)}', {rule.confidence}, {rule.evidence_count}, "
            f"'{_sql_escape(rule.first_seen)}', '{_sql_escape(rule.last_seen)}', 'proposed', '{_sql_escape(str(target))}', {run_id}, '{_sql_escape(meta)}'::jsonb) "
            "ON CONFLICT (feedback_type, rule_text) DO UPDATE SET "
            "confidence = EXCLUDED.confidence, evidence_count = EXCLUDED.evidence_count, last_seen = EXCLUDED.last_seen, source_run_id = EXCLUDED.source_run_id;"
        )

        if rule.confidence >= auto_threshold and rule.evidence_count >= 2:
            _apply_rule_to_file(target, rule)
            _run_psql(
                "UPDATE cortana_reflection_rules SET status='applied', applied_at=NOW() "
                f"WHERE feedback_type='{_sql_escape(rule.feedback_type)}' AND rule_text='{_sql_escape(rule.rule_text)}';"
            )
            applied += 1
    return applied


def run(trigger_source: str, mode: str, window_days: int, task_id: int | None, auto_threshold: float) -> None:
    run_id = _start_run(trigger_source, mode, window_days)
    try:
        reflected_tasks = _task_reflection(run_id, explicit_task_id=task_id)
        rules, repeated_rate, feedback_rows = _extract_rules(window_days)
        auto_applied = _upsert_rules(run_id, rules, auto_threshold=auto_threshold)

        _write_journal(
            run_id,
            "kpi",
            "Repeated correction rate",
            f"{repeated_rate:.2f}% over last {window_days} days",
            {"window_days": window_days, "feedback_rows": feedback_rows},
        )

        _run_psql(
            "UPDATE cortana_reflection_runs SET "
            f"completed_at=NOW(), status='completed', feedback_rows={feedback_rows}, reflected_tasks={reflected_tasks}, "
            f"rules_extracted={len(rules)}, rules_auto_applied={auto_applied}, repeated_correction_rate={repeated_rate}, "
            f"summary='{_sql_escape(f'Processed {feedback_rows} feedback rows, extracted {len(rules)} rules, auto-applied {auto_applied}.')}' "
            f"WHERE id={run_id};"
        )

        print(
            json.dumps(
                {
                    "run_id": run_id,
                    "status": "completed",
                    "reflected_tasks": reflected_tasks,
                    "feedback_rows": feedback_rows,
                    "rules_extracted": len(rules),
                    "rules_auto_applied": auto_applied,
                    "repeated_correction_rate": repeated_rate,
                }
            )
        )
    except Exception as exc:  # noqa: BLE001
        _write_journal(run_id, "error", "Reflection run failed", str(exc), {})
        _run_psql(
            "UPDATE cortana_reflection_runs SET completed_at=NOW(), status='failed', "
            f"error='{_sql_escape(str(exc))}' WHERE id={run_id};"
        )
        raise


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Cortana reflection loop")
    p.add_argument("--mode", choices=["sweep", "task"], default="sweep")
    p.add_argument("--trigger-source", default="manual", choices=["manual", "heartbeat", "post_task", "cron"])
    p.add_argument("--window-days", type=int, default=30)
    p.add_argument("--task-id", type=int)
    p.add_argument("--auto-apply-threshold", type=float, default=0.82)
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if args.mode == "task" and not args.task_id:
        print("--task-id is required for --mode task", file=sys.stderr)
        sys.exit(2)
    run(args.trigger_source, args.mode, args.window_days, args.task_id, args.auto_apply_threshold)
