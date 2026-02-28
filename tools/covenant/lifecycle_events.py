#!/usr/bin/env python3
"""Publish sub-agent lifecycle events to Cortana event bus."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql"
DEFAULT_DB = "cortana"
EVENT_SOURCE = "agent_lifecycle"
TRACE_CLI = Path("/Users/hd/openclaw/tools/covenant/trace.py")


class LifecycleEventError(Exception):
    pass


def sql_quote(value: str) -> str:
    return value.replace("'", "''")


def run_psql(db: str, sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/opt/postgresql@17/bin:" + env.get("PATH", "")

    proc = subprocess.run(
        [PSQL_BIN, db, "-X", "-q", "-At", "-c", sql],
        capture_output=True,
        text=True,
        env=env,
    )
    if proc.returncode != 0:
        raise LifecycleEventError(proc.stderr.strip() or "psql command failed")
    return proc.stdout.strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log_trace_span(
    db: str,
    trace_id: str | None,
    span_name: str,
    agent_role: str,
    task_id: int,
    chain_id: str,
    started_at: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    if not trace_id or not TRACE_CLI.exists():
        return

    meta = metadata or {}
    cmd = [
        "python3",
        str(TRACE_CLI),
        "--db",
        db,
        "log",
        trace_id,
        span_name,
        "--agent",
        agent_role,
        "--task",
        str(task_id),
        "--chain-id",
        chain_id,
        "--start",
        started_at,
        "--end",
        _now_iso(),
        "--metadata",
        json.dumps(meta, ensure_ascii=False),
    ]

    subprocess.run(cmd, capture_output=True, text=True)


def publish_event(db: str, event_type: str, payload: dict[str, Any]) -> int:
    payload_json = json.dumps(payload, ensure_ascii=False)
    sql = (
        "SELECT cortana_event_bus_publish("
        f"'{sql_quote(event_type)}', "
        f"'{EVENT_SOURCE}', "
        f"'{sql_quote(payload_json)}'::jsonb, "
        "NULL"
        ");"
    )
    out = run_psql(db, sql)
    try:
        return int(out)
    except ValueError as exc:
        raise LifecycleEventError(f"Unexpected publish result: {out!r}") from exc


def publish_spawn(
    agent_role: str,
    task_id: int,
    chain_id: str,
    label: str,
    model: str,
    trace_id: str | None = None,
    db: str = DEFAULT_DB,
) -> int:
    return publish_event(
        db,
        "agent_spawned",
        {
            "agent_role": agent_role,
            "task_id": task_id,
            "chain_id": chain_id,
            "trace_id": trace_id,
            "label": label,
            "model": model,
        },
    )


def publish_completion(
    agent_role: str,
    task_id: int,
    chain_id: str,
    label: str,
    duration_ms: int,
    outcome_summary: str,
    trace_id: str | None = None,
    db: str = DEFAULT_DB,
) -> int:
    return publish_event(
        db,
        "agent_completed",
        {
            "agent_role": agent_role,
            "task_id": task_id,
            "chain_id": chain_id,
            "trace_id": trace_id,
            "label": label,
            "duration_ms": duration_ms,
            "outcome_summary": outcome_summary,
        },
    )


def publish_failure(
    agent_role: str,
    task_id: int,
    chain_id: str,
    label: str,
    error: str,
    duration_ms: int,
    trace_id: str | None = None,
    db: str = DEFAULT_DB,
) -> int:
    return publish_event(
        db,
        "agent_failed",
        {
            "agent_role": agent_role,
            "task_id": task_id,
            "chain_id": chain_id,
            "trace_id": trace_id,
            "label": label,
            "error": error,
            "duration_ms": duration_ms,
        },
    )


def publish_timeout(
    agent_role: str,
    task_id: int,
    chain_id: str,
    label: str,
    timeout_seconds: int,
    trace_id: str | None = None,
    db: str = DEFAULT_DB,
) -> int:
    return publish_event(
        db,
        "agent_timeout",
        {
            "agent_role": agent_role,
            "task_id": task_id,
            "chain_id": chain_id,
            "trace_id": trace_id,
            "label": label,
            "timeout_seconds": timeout_seconds,
        },
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Publish agent lifecycle event")
    parser.add_argument("--db", default=DEFAULT_DB, help="PostgreSQL database (default: cortana)")

    sub = parser.add_subparsers(dest="command", required=True)

    base_parent = argparse.ArgumentParser(add_help=False)
    base_parent.add_argument("--agent-role", required=True)
    base_parent.add_argument("--task-id", type=int, required=True)
    base_parent.add_argument("--chain-id", required=True)
    base_parent.add_argument("--trace-id", help="Correlation trace id (UUID)")
    base_parent.add_argument("--label", required=True)

    sp = sub.add_parser("spawn", parents=[base_parent], help="Publish agent_spawned")
    sp.add_argument("--model", required=True)

    cp = sub.add_parser("complete", parents=[base_parent], help="Publish agent_completed")
    cp.add_argument("--duration-ms", type=int, required=True)
    cp.add_argument("--outcome-summary", required=True)

    fp = sub.add_parser("fail", parents=[base_parent], help="Publish agent_failed")
    fp.add_argument("--error", required=True)
    fp.add_argument("--duration-ms", type=int, required=True)

    tp = sub.add_parser("timeout", parents=[base_parent], help="Publish agent_timeout")
    tp.add_argument("--timeout-seconds", type=int, required=True)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        started_at = _now_iso()

        if args.command == "spawn":
            event_id = publish_spawn(
                args.agent_role,
                args.task_id,
                args.chain_id,
                args.label,
                args.model,
                trace_id=args.trace_id,
                db=args.db,
            )
            event_type = "agent_spawned"
            log_trace_span(
                args.db,
                args.trace_id,
                "agent_spawn",
                args.agent_role,
                args.task_id,
                args.chain_id,
                started_at,
                {"label": args.label, "model": args.model},
            )
        elif args.command == "complete":
            event_id = publish_completion(
                args.agent_role,
                args.task_id,
                args.chain_id,
                args.label,
                args.duration_ms,
                args.outcome_summary,
                trace_id=args.trace_id,
                db=args.db,
            )
            event_type = "agent_completed"
            log_trace_span(
                args.db,
                args.trace_id,
                "agent_complete",
                args.agent_role,
                args.task_id,
                args.chain_id,
                started_at,
                {"label": args.label, "outcome_summary": args.outcome_summary},
            )
        elif args.command == "fail":
            event_id = publish_failure(
                args.agent_role,
                args.task_id,
                args.chain_id,
                args.label,
                args.error,
                args.duration_ms,
                trace_id=args.trace_id,
                db=args.db,
            )
            event_type = "agent_failed"
            log_trace_span(
                args.db,
                args.trace_id,
                "agent_fail",
                args.agent_role,
                args.task_id,
                args.chain_id,
                started_at,
                {"label": args.label, "error": args.error},
            )
        elif args.command == "timeout":
            event_id = publish_timeout(
                args.agent_role,
                args.task_id,
                args.chain_id,
                args.label,
                args.timeout_seconds,
                trace_id=args.trace_id,
                db=args.db,
            )
            event_type = "agent_timeout"
            log_trace_span(
                args.db,
                args.trace_id,
                "agent_timeout",
                args.agent_role,
                args.task_id,
                args.chain_id,
                started_at,
                {"label": args.label, "timeout_seconds": args.timeout_seconds},
            )
        else:
            raise LifecycleEventError(f"Unsupported command: {args.command}")

        print(json.dumps({"ok": True, "event_id": event_id, "event_type": event_type, "trace_id": args.trace_id}))
        return 0
    except LifecycleEventError as exc:
        print(f"LIFECYCLE_EVENT_ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
