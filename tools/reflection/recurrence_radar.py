#!/usr/bin/env python3
"""Reflection recurrence radar v2.

Clusters similar correction lessons and escalates recurring mistakes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import statistics
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any

DB_NAME = "cortana"
DB_PATH = "/opt/homebrew/opt/postgresql@17/bin"
SOURCE = "recurrence_radar"


@dataclass
class FeedbackRow:
    id: int
    timestamp: datetime
    feedback_type: str
    context: str
    lesson: str


@dataclass
class Cluster:
    key: str
    canonical_lesson: str
    items: list[FeedbackRow] = field(default_factory=list)

    @property
    def size(self) -> int:
        return len(self.items)


def _sql_escape(text: str) -> str:
    return text.replace("'", "''")


def run_psql(sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{DB_PATH}:{env.get('PATH', '')}"
    cmd = ["psql", DB_NAME, "-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql]
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "psql failed")
    return proc.stdout.strip()


def fetch_json(sql: str) -> list[dict[str, Any]]:
    wrapped = f"SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ({sql}) t;"
    raw = run_psql(wrapped)
    return json.loads(raw) if raw else []


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def normalize(text: str) -> str:
    return " ".join((text or "").strip().lower().split())


def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, normalize(a), normalize(b)).ratio()


def start_run(trigger_source: str, window_days: int, dry_run: bool) -> int | None:
    if dry_run:
        return None
    rid = run_psql(
        "INSERT INTO cortana_reflection_runs (trigger_source, mode, window_days, status) "
        f"VALUES ('{_sql_escape(trigger_source)}', 'recurrence_radar', {window_days}, 'running') RETURNING id;"
    )
    return int(rid)


def log_event(event_type: str, severity: str, message: str, metadata: dict[str, Any], dry_run: bool) -> None:
    if dry_run:
        return
    meta = _sql_escape(json.dumps(metadata, separators=(",", ":")))
    run_psql(
        "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES "
        f"('{_sql_escape(event_type)}','{SOURCE}','{_sql_escape(severity)}','{_sql_escape(message)}','{meta}'::jsonb);"
    )


def fetch_feedback(window_days: int) -> list[FeedbackRow]:
    rows = fetch_json(
        "SELECT id, timestamp, feedback_type, COALESCE(context,'') AS context, COALESCE(lesson,'') AS lesson "
        "FROM cortana_feedback "
        "WHERE COALESCE(lesson, '') <> '' "
        "  AND feedback_type IN ('correction', 'behavior', 'tone', 'preference', 'fact') "
        f"  AND timestamp > NOW() - INTERVAL '{max(1, window_days)} days' "
        "ORDER BY timestamp ASC"
    )
    return [
        FeedbackRow(
            id=int(r["id"]),
            timestamp=parse_ts(r["timestamp"]),
            feedback_type=r["feedback_type"],
            context=r.get("context", ""),
            lesson=r.get("lesson", ""),
        )
        for r in rows
    ]


def cluster_feedback(rows: list[FeedbackRow], threshold: float) -> list[Cluster]:
    clusters: list[Cluster] = []
    for row in rows:
        best_cluster: Cluster | None = None
        best_score = 0.0
        for cluster in clusters:
            score = similarity(row.lesson, cluster.canonical_lesson)
            if score > best_score:
                best_score = score
                best_cluster = cluster
        if best_cluster and best_score >= threshold:
            best_cluster.items.append(row)
            # Keep canonical text stable but representative.
            best_cluster.canonical_lesson = min(
                [best_cluster.canonical_lesson, row.lesson], key=lambda x: abs(len(x) - 100)
            )
        else:
            key = hashlib.sha1(normalize(row.lesson).encode("utf-8")).hexdigest()[:12]
            clusters.append(Cluster(key=key, canonical_lesson=row.lesson, items=[row]))
    return clusters


def time_to_recurrence_hours(cluster: Cluster) -> float | None:
    if cluster.size < 2:
        return None
    sorted_items = sorted(cluster.items, key=lambda x: x.timestamp)
    delta = sorted_items[1].timestamp - sorted_items[0].timestamp
    return round(delta.total_seconds() / 3600.0, 2)


def repeats_per_7d(cluster: Cluster) -> float:
    if cluster.size < 2:
        return 0.0
    sorted_items = sorted(cluster.items, key=lambda x: x.timestamp)
    total_days = max(1 / 24, (sorted_items[-1].timestamp - sorted_items[0].timestamp).total_seconds() / 86400)
    repeat_count = cluster.size - 1
    return round(repeat_count / (total_days / 7), 2)


def ensure_remediation_task(cluster: Cluster, dry_run: bool) -> int | None:
    cluster_hash = hashlib.sha1(normalize(cluster.canonical_lesson).encode("utf-8")).hexdigest()
    existing = run_psql(
        "SELECT COALESCE((SELECT id FROM cortana_tasks "
        "WHERE status IN ('ready','in_progress') "
        f"  AND metadata->>'recurrence_cluster_hash' = '{cluster_hash}' "
        "ORDER BY id DESC LIMIT 1), 0);"
    )
    existing_id = int(existing or 0)
    if existing_id:
        return existing_id
    if dry_run:
        return None

    title = f"Remediate recurring correction cluster: {cluster.canonical_lesson[:72]}"
    desc = (
        "Recurrence radar detected 5+ repeats for a correction pattern. "
        "Create and apply durable fix in AGENTS/SOUL/MEMORY/scripts as appropriate."
    )
    metadata = {
        "created_by": SOURCE,
        "recurrence_cluster_hash": cluster_hash,
        "cluster_size": cluster.size,
        "sample_feedback_ids": [item.id for item in cluster.items[:10]],
        "canonical_lesson": cluster.canonical_lesson,
    }
    new_id = run_psql(
        "INSERT INTO cortana_tasks (source, title, description, priority, auto_executable, status, execution_plan, metadata) "
        f"VALUES ('reflection', '{_sql_escape(title)}', '{_sql_escape(desc)}', 1, true, 'ready', "
        "'1) Inspect recurrence evidence 2) Strengthen rule language 3) Verify no further repeats', "
        f"'{_sql_escape(json.dumps(metadata))}'::jsonb) RETURNING id;"
    )
    return int(new_id)


def escalation_for_size(size: int) -> str | None:
    if size >= 5:
        return "create_remediation_task"
    if size >= 3:
        return "suggest_rule_strengthening"
    if size >= 2:
        return "warning"
    return None


def run(window_days: int, threshold: float, trigger_source: str, dry_run: bool) -> dict[str, Any]:
    run_id = start_run(trigger_source=trigger_source, window_days=window_days, dry_run=dry_run)
    try:
        rows = fetch_feedback(window_days=window_days)
        clusters = cluster_feedback(rows, threshold=threshold)
        recurring = [c for c in clusters if c.size >= 2]

        cluster_reports: list[dict[str, Any]] = []
        ttr_values: list[float] = []

        for cluster in recurring:
            sorted_items = sorted(cluster.items, key=lambda x: x.timestamp)
            ttr_hours = time_to_recurrence_hours(cluster)
            if ttr_hours is not None:
                ttr_values.append(ttr_hours)
            r7 = repeats_per_7d(cluster)
            escalation = escalation_for_size(cluster.size)
            remediation_task_id: int | None = None

            if escalation == "warning":
                log_event(
                    "recurrence_warning",
                    "warning",
                    f"Recurring correction cluster detected (size=2): {cluster.canonical_lesson[:160]}",
                    {
                        "run_id": run_id,
                        "cluster_key": cluster.key,
                        "cluster_size": cluster.size,
                        "feedback_ids": [x.id for x in sorted_items],
                        "time_to_recurrence_hours": ttr_hours,
                        "repeats_per_7d": r7,
                    },
                    dry_run,
                )
            elif escalation == "suggest_rule_strengthening":
                suggestion = (
                    "Strengthen rule language from soft guidance to explicit prohibition + required action."
                )
                log_event(
                    "recurrence_escalation",
                    "warning",
                    f"Cluster reached size {cluster.size}; rule-strengthening suggested",
                    {
                        "run_id": run_id,
                        "cluster_key": cluster.key,
                        "cluster_size": cluster.size,
                        "suggestion": suggestion,
                        "canonical_lesson": cluster.canonical_lesson,
                    },
                    dry_run,
                )
            elif escalation == "create_remediation_task":
                remediation_task_id = ensure_remediation_task(cluster, dry_run=dry_run)
                log_event(
                    "recurrence_escalation",
                    "error",
                    f"Cluster reached size {cluster.size}; remediation task queued",
                    {
                        "run_id": run_id,
                        "cluster_key": cluster.key,
                        "cluster_size": cluster.size,
                        "task_id": remediation_task_id,
                    },
                    dry_run,
                )

            cluster_reports.append(
                {
                    "cluster_key": cluster.key,
                    "size": cluster.size,
                    "canonical_lesson": cluster.canonical_lesson,
                    "feedback_ids": [x.id for x in sorted_items],
                    "first_seen": sorted_items[0].timestamp.isoformat(),
                    "last_seen": sorted_items[-1].timestamp.isoformat(),
                    "time_to_recurrence_hours": ttr_hours,
                    "repeats_per_7d": r7,
                    "escalation": escalation,
                    "remediation_task_id": remediation_task_id,
                }
            )

        avg_ttr = round(statistics.mean(ttr_values), 2) if ttr_values else None
        report = {
            "run_id": run_id,
            "status": "completed",
            "window_days": window_days,
            "similarity_threshold": threshold,
            "feedback_rows": len(rows),
            "clusters_total": len(clusters),
            "recurring_clusters": len(recurring),
            "sla_metrics": {
                "avg_time_to_recurrence_hours": avg_ttr,
                "cluster_time_to_recurrence_hours": {
                    r["cluster_key"]: r["time_to_recurrence_hours"] for r in cluster_reports
                },
                "cluster_repeats_per_7d": {r["cluster_key"]: r["repeats_per_7d"] for r in cluster_reports},
            },
            "clusters": cluster_reports,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "dry_run": dry_run,
        }

        if not dry_run and run_id is not None:
            summary = (
                f"Radar processed {len(rows)} rows, found {len(recurring)} recurring clusters "
                f"(threshold={threshold:.2f})."
            )
            run_psql(
                "UPDATE cortana_reflection_runs SET completed_at=NOW(), status='completed', "
                f"feedback_rows={len(rows)}, rules_extracted={len(recurring)}, summary='{_sql_escape(summary)}', "
                f"metadata='{_sql_escape(json.dumps(report))}'::jsonb WHERE id={run_id};"
            )
        return report
    except Exception as exc:  # noqa: BLE001
        if not dry_run and run_id is not None:
            run_psql(
                "UPDATE cortana_reflection_runs SET completed_at=NOW(), status='failed', "
                f"error='{_sql_escape(str(exc))}' WHERE id={run_id};"
            )
        raise


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Recurrence radar v2 for cortana_feedback corrections")
    p.add_argument("--window-days", type=int, default=30, help="How far back to analyze corrections")
    p.add_argument("--similarity-threshold", type=float, default=0.72, help="difflib similarity threshold (0-1)")
    p.add_argument("--trigger-source", default="manual", choices=["manual", "heartbeat", "cron", "post_task"])
    p.add_argument("--dry-run", action="store_true", help="No DB writes (events/tasks/run updates)")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    report = run(
        window_days=max(1, args.window_days),
        threshold=min(0.99, max(0.1, args.similarity_threshold)),
        trigger_source=args.trigger_source,
        dry_run=args.dry_run,
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
