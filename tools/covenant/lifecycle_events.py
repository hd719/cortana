#!/usr/bin/env python3
"""Publish sub-agent lifecycle events to Cortana event bus."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any

PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql"
DEFAULT_DB = "cortana"
EVENT_SOURCE = "agent_lifecycle"


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


def publish_spawn(agent_role: str, task_id: int, chain_id: str, label: str, model: str, db: str = DEFAULT_DB) -> int:
    return publish_event(
        db,
        "agent_spawned",
        {
            "agent_role": agent_role,
            "task_id": task_id,
            "chain_id": chain_id,
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
    db: str = DEFAULT_DB,
) -> int:
    return publish_event(
        db,
        "agent_completed",
        {
            "agent_role": agent_role,
            "task_id": task_id,
            "chain_id": chain_id,
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
    db: str = DEFAULT_DB,
) -> int:
    return publish_event(
        db,
        "agent_failed",
        {
            "agent_role": agent_role,
            "task_id": task_id,
            "chain_id": chain_id,
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
    db: str = DEFAULT_DB,
) -> int:
    return publish_event(
        db,
        "agent_timeout",
        {
            "agent_role": agent_role,
            "task_id": task_id,
            "chain_id": chain_id,
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
        if args.command == "spawn":
            event_id = publish_spawn(args.agent_role, args.task_id, args.chain_id, args.label, args.model, db=args.db)
            event_type = "agent_spawned"
        elif args.command == "complete":
            event_id = publish_completion(
                args.agent_role,
                args.task_id,
                args.chain_id,
                args.label,
                args.duration_ms,
                args.outcome_summary,
                db=args.db,
            )
            event_type = "agent_completed"
        elif args.command == "fail":
            event_id = publish_failure(
                args.agent_role,
                args.task_id,
                args.chain_id,
                args.label,
                args.error,
                args.duration_ms,
                db=args.db,
            )
            event_type = "agent_failed"
        elif args.command == "timeout":
            event_id = publish_timeout(
                args.agent_role,
                args.task_id,
                args.chain_id,
                args.label,
                args.timeout_seconds,
                db=args.db,
            )
            event_type = "agent_timeout"
        else:
            raise LifecycleEventError(f"Unsupported command: {args.command}")

        print(json.dumps({"ok": True, "event_id": event_id, "event_type": event_type}))
        return 0
    except LifecycleEventError as exc:
        print(f"LIFECYCLE_EVENT_ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
