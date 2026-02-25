#!/usr/bin/env python3
"""Heartbeat-safe state integrity auditor for cortana_tasks."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any

DB_NAME = "cortana"
DB_PATH = "/opt/homebrew/opt/postgresql@17/bin"
SOURCE = "state_integrity"


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


def log_event(event_type: str, severity: str, message: str, metadata: dict[str, Any], dry_run: bool) -> None:
    if dry_run:
        return
    meta = _sql_escape(json.dumps(metadata, separators=(",", ":")))
    run_psql(
        "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES "
        f"('{_sql_escape(event_type)}', '{SOURCE}', '{_sql_escape(severity)}', "
        f"'{_sql_escape(message)}', '{meta}'::jsonb);"
    )


def fix_done_missing_completed_at(limit: int, dry_run: bool) -> list[int]:
    rows = fetch_json(
        "SELECT id FROM cortana_tasks "
        "WHERE status='done' AND completed_at IS NULL "
        f"ORDER BY id ASC LIMIT {max(1, limit)}"
    )
    ids = [int(r["id"]) for r in rows]
    if ids and not dry_run:
        run_psql(
            "UPDATE cortana_tasks SET completed_at = NOW(), updated_at = CURRENT_TIMESTAMP "
            f"WHERE id = ANY(ARRAY[{','.join(str(i) for i in ids)}]::int[]) AND completed_at IS NULL;"
        )
    if ids:
        log_event(
            "auto_heal",
            "info",
            f"Filled completed_at for {len(ids)} done task(s)",
            {"task_ids": ids, "fix": "set_completed_at_now", "dry_run": dry_run},
            dry_run,
        )
    return ids


def detect_orphaned_in_progress(orphan_minutes: int, limit: int) -> list[dict[str, Any]]:
    return fetch_json(
        "SELECT t.id, t.title, t.assigned_to, t.updated_at, t.created_at "
        "FROM cortana_tasks t "
        "WHERE t.status='in_progress' "
        f"  AND COALESCE(t.updated_at, t.created_at, NOW()) < NOW() - INTERVAL '{max(1, orphan_minutes)} minutes' "
        "  AND NOT EXISTS ("
        "    SELECT 1 FROM cortana_covenant_runs r "
        "    WHERE (r.status = 'running' OR r.ended_at IS NULL) "
        "      AND ("
        "        (t.assigned_to IS NOT NULL AND r.agent = t.assigned_to) "
        "        OR (t.assigned_to IS NOT NULL AND r.session_key = t.assigned_to)"
        "      )"
        "  ) "
        "ORDER BY COALESCE(t.updated_at, t.created_at) ASC "
        f"LIMIT {max(1, limit)}"
    )


def detect_completed_with_pending_children(limit: int) -> list[dict[str, Any]]:
    return fetch_json(
        "SELECT p.id AS parent_id, p.title AS parent_title, COUNT(c.id)::int AS pending_children "
        "FROM cortana_tasks p "
        "JOIN cortana_tasks c ON c.parent_id = p.id "
        "WHERE p.status='done' AND c.status IN ('pending', 'in_progress', 'blocked') "
        "GROUP BY p.id, p.title "
        "ORDER BY pending_children DESC, p.id ASC "
        f"LIMIT {max(1, limit)}"
    )


def audit(orphan_minutes: int, fix_limit: int, detect_limit: int, dry_run: bool) -> dict[str, Any]:
    fixed_done = fix_done_missing_completed_at(limit=fix_limit, dry_run=dry_run)
    orphaned = detect_orphaned_in_progress(orphan_minutes=orphan_minutes, limit=detect_limit)
    completed_with_pending = detect_completed_with_pending_children(limit=detect_limit)

    if orphaned:
        log_event(
            "integrity_warning",
            "warning",
            f"Detected {len(orphaned)} orphaned in_progress task(s)",
            {"orphaned_tasks": orphaned, "orphan_minutes": orphan_minutes, "dry_run": dry_run},
            dry_run,
        )

    if completed_with_pending:
        log_event(
            "integrity_warning",
            "warning",
            f"Detected {len(completed_with_pending)} completed parent task(s) with pending children",
            {"mismatches": completed_with_pending, "dry_run": dry_run},
            dry_run,
        )

    summary = {
        "status": "ok",
        "dry_run": dry_run,
        "fixed": {
            "done_missing_completed_at": len(fixed_done),
            "task_ids": fixed_done,
        },
        "detected": {
            "orphaned_in_progress": orphaned,
            "completed_with_pending_children": completed_with_pending,
        },
    }
    return summary


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Run cortana_tasks state integrity audit (quick, idempotent, heartbeat-safe)."
    )
    p.add_argument("--orphan-minutes", type=int, default=30, help="Age threshold for orphaned in_progress tasks")
    p.add_argument("--fix-limit", type=int, default=200, help="Max low-risk fixes per run")
    p.add_argument("--detect-limit", type=int, default=200, help="Max anomalies returned per detector")
    p.add_argument("--dry-run", action="store_true", help="Detect only; do not update tasks or write events")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report = audit(
            orphan_minutes=args.orphan_minutes,
            fix_limit=args.fix_limit,
            detect_limit=args.detect_limit,
            dry_run=args.dry_run,
        )
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"status": "error", "error": str(exc)}), file=sys.stderr)
        return 1

    print(json.dumps(report, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
