#!/usr/bin/env python3
"""Handoff Artifact Bus (HAB) CLI for Cortana-controlled inter-agent context relay."""

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
DEFAULT_CREATED_BY = "cortana"
ALLOWED_CREATED_BY = {"cortana"}
TRACE_CLI = Path("/Users/hd/openclaw/tools/covenant/trace.py")


class HabError(Exception):
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
        raise HabError(proc.stderr.strip() or "psql command failed")
    return proc.stdout.strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log_trace_span(
    db: str,
    trace_id: str | None,
    span_name: str,
    from_agent: str,
    chain_id: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    if not trace_id or not TRACE_CLI.exists():
        return

    cmd = [
        "python3",
        str(TRACE_CLI),
        "--db",
        db,
        "log",
        trace_id,
        span_name,
        "--agent",
        from_agent,
        "--chain-id",
        chain_id,
        "--start",
        _now_iso(),
        "--end",
        _now_iso(),
        "--metadata",
        json.dumps(metadata or {}, ensure_ascii=False),
    ]
    subprocess.run(cmd, capture_output=True, text=True)


def publish_event(db: str, event_type: str, payload: dict[str, Any]) -> None:
    payload_json = json.dumps(payload, ensure_ascii=False)
    sql = (
        "SELECT cortana_event_bus_publish("
        f"'{sql_quote(event_type)}', "
        "'artifact_bus', "
        f"'{sql_quote(payload_json)}'::jsonb, "
        "NULL"
        ");"
    )
    run_psql(db, sql)


def parse_payload(payload: str | None, payload_file: str | None) -> dict[str, Any]:
    if payload and payload_file:
        raise HabError("Use only one of --payload or --payload-file")
    if payload_file:
        return json.loads(Path(payload_file).read_text(encoding="utf-8"))
    if payload:
        return json.loads(payload)
    raise HabError("Payload is required (--payload or --payload-file)")


def cmd_write(args: argparse.Namespace) -> int:
    created_by = args.created_by or DEFAULT_CREATED_BY
    if created_by not in ALLOWED_CREATED_BY:
        raise HabError("created_by must be 'cortana'")

    payload_obj = parse_payload(args.payload, args.payload_file)
    payload_json = json.dumps(payload_obj, ensure_ascii=False)

    to_agent_sql = "NULL"
    if args.to_agent:
        to_agent_sql = f"'{sql_quote(args.to_agent)}'"

    sql = (
        "WITH ins AS ("
        "INSERT INTO cortana_handoff_artifacts "
        "(chain_id, from_agent, to_agent, artifact_type, payload, created_by) "
        "VALUES ("
        f"'{sql_quote(args.chain_id)}'::uuid, "
        f"'{sql_quote(args.from_agent)}', "
        f"{to_agent_sql}, "
        f"'{sql_quote(args.artifact_type)}', "
        f"'{sql_quote(payload_json)}'::jsonb, "
        f"'{sql_quote(created_by)}'"
        ") RETURNING id, chain_id, from_agent, to_agent, artifact_type, created_by, created_at"
        ") SELECT row_to_json(ins)::text FROM ins;"
    )
    out = run_psql(args.db, sql)
    row = json.loads(out) if out else {}

    publish_event(
        args.db,
        "artifact_created",
        {
            "artifact_id": row.get("id"),
            "chain_id": row.get("chain_id"),
            "trace_id": args.trace_id,
            "from_agent": row.get("from_agent"),
            "to_agent": row.get("to_agent"),
            "artifact_type": row.get("artifact_type"),
            "created_by": row.get("created_by"),
        },
    )

    log_trace_span(
        args.db,
        args.trace_id,
        "artifact_write",
        args.from_agent,
        args.chain_id,
        {
            "artifact_id": row.get("id"),
            "to_agent": row.get("to_agent"),
            "artifact_type": row.get("artifact_type"),
        },
    )

    print(json.dumps({"ok": True, "artifact": row, "trace_id": args.trace_id}, ensure_ascii=False))
    return 0


def cmd_read(args: argparse.Namespace) -> int:
    filters = [f"chain_id = '{sql_quote(args.chain_id)}'::uuid"]

    if args.to_agent:
        filters.append(
            f"(to_agent IS NULL OR to_agent = '{sql_quote(args.to_agent)}')"
        )

    if not args.include_consumed:
        filters.append("consumed_at IS NULL")

    where_sql = " AND ".join(filters)

    sql = (
        "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.created_at ASC), '[]'::json)::text "
        "FROM ("
        "SELECT id, chain_id, from_agent, to_agent, artifact_type, payload, created_by, consumed_at, created_at "
        "FROM cortana_handoff_artifacts "
        f"WHERE {where_sql} "
        "ORDER BY created_at ASC"
        ") t;"
    )
    out = run_psql(args.db, sql)
    print(json.dumps({"ok": True, "artifacts": json.loads(out or "[]")}, ensure_ascii=False))
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.created_at ASC), '[]'::json)::text "
        "FROM ("
        "SELECT id, chain_id, from_agent, to_agent, artifact_type, created_by, consumed_at, created_at, "
        "CASE WHEN consumed_at IS NULL THEN 'unconsumed' ELSE 'consumed' END AS status "
        "FROM cortana_handoff_artifacts "
        f"WHERE chain_id = '{sql_quote(args.chain_id)}'::uuid "
        "ORDER BY created_at ASC"
        ") t;"
    )
    out = run_psql(args.db, sql)
    print(json.dumps({"ok": True, "artifacts": json.loads(out or "[]")}, ensure_ascii=False))
    return 0


def cmd_consume(args: argparse.Namespace) -> int:
    filters = [f"chain_id = '{sql_quote(args.chain_id)}'::uuid", "consumed_at IS NULL"]

    if args.to_agent:
        filters.append(
            f"(to_agent IS NULL OR to_agent = '{sql_quote(args.to_agent)}')"
        )

    if args.ids:
        id_list = ",".join(str(int(x)) for x in args.ids)
        filters.append(f"id IN ({id_list})")

    where_sql = " AND ".join(filters)

    sql = (
        "WITH upd AS ("
        "UPDATE cortana_handoff_artifacts "
        "SET consumed_at = NOW() "
        f"WHERE {where_sql} "
        "RETURNING id, chain_id, from_agent, to_agent, artifact_type, consumed_at"
        ") SELECT COALESCE(json_agg(row_to_json(upd)), '[]'::json)::text FROM upd;"
    )
    out = run_psql(args.db, sql)
    consumed = json.loads(out or "[]")

    for item in consumed:
        publish_event(
            args.db,
            "artifact_consumed",
            {
                "artifact_id": item.get("id"),
                "chain_id": item.get("chain_id"),
                "trace_id": args.trace_id,
                "from_agent": item.get("from_agent"),
                "to_agent": item.get("to_agent"),
                "artifact_type": item.get("artifact_type"),
                "consumed_at": item.get("consumed_at"),
            },
        )
        log_trace_span(
            args.db,
            args.trace_id,
            "artifact_consume",
            item.get("from_agent") or "unknown",
            args.chain_id,
            {
                "artifact_id": item.get("id"),
                "to_agent": item.get("to_agent"),
                "artifact_type": item.get("artifact_type"),
                "consumed_at": item.get("consumed_at"),
            },
        )

    print(json.dumps({"ok": True, "consumed": consumed, "count": len(consumed), "trace_id": args.trace_id}, ensure_ascii=False))
    return 0


def cmd_cleanup(args: argparse.Namespace) -> int:
    sql = (
        "WITH del AS ("
        "DELETE FROM cortana_handoff_artifacts "
        f"WHERE created_at < NOW() - INTERVAL '{int(args.days)} days' "
        "RETURNING id"
        ") SELECT COUNT(*)::text FROM del;"
    )
    out = run_psql(args.db, sql)
    print(json.dumps({"ok": True, "deleted": int(out or 0), "older_than_days": int(args.days)}))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Cortana HAB CLI")
    parser.add_argument("--db", default=DEFAULT_DB, help="PostgreSQL database (default: cortana)")

    sub = parser.add_subparsers(dest="command", required=True)

    w = sub.add_parser("write", help="Write artifact")
    w.add_argument("--chain-id", required=True)
    w.add_argument("--from-agent", required=True)
    w.add_argument("--to-agent")
    w.add_argument("--artifact-type", required=True)
    w.add_argument("--payload")
    w.add_argument("--payload-file")
    w.add_argument("--created-by", default=DEFAULT_CREATED_BY)
    w.add_argument("--trace-id", help="Correlation trace id (UUID)")
    w.set_defaults(func=cmd_write)

    r = sub.add_parser("read", help="Read artifacts")
    r.add_argument("--chain-id", required=True)
    r.add_argument("--to-agent", help="Read artifacts intended for this agent or broadcast (NULL)")
    r.add_argument("--include-consumed", action="store_true", help="Include already consumed artifacts")
    r.set_defaults(func=cmd_read)

    c = sub.add_parser("consume", help="Mark artifacts as consumed")
    c.add_argument("--chain-id", required=True)
    c.add_argument("--to-agent", help="Consume artifacts for this agent or broadcast (NULL)")
    c.add_argument("--ids", nargs="*", help="Specific artifact IDs to consume")
    c.add_argument("--trace-id", help="Correlation trace id (UUID)")
    c.set_defaults(func=cmd_consume)

    l = sub.add_parser("list", help="List all artifacts for chain")
    l.add_argument("--chain-id", required=True)
    l.set_defaults(func=cmd_list)

    cl = sub.add_parser("cleanup", help="Delete artifacts older than N days")
    cl.add_argument("--days", type=int, required=True)
    cl.set_defaults(func=cmd_cleanup)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        return int(args.func(args))
    except HabError as exc:
        print(f"HAB_ERROR: {exc}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"HAB_ERROR: invalid JSON payload: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
