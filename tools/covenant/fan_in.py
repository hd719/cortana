#!/usr/bin/env python3
"""Fan-in helpers for Covenant parallel execution groups."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

# Allow running as package import or script from tools/covenant
try:
    from executor import group_is_complete  # type: ignore
except Exception:  # pragma: no cover
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from executor import group_is_complete  # type: ignore

PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql"
DEFAULT_DB = "cortana"
WORKSPACE_ROOT = Path("/Users/hd/openclaw")


class FanInError(Exception):
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
        raise FanInError(proc.stderr.strip() or "psql command failed")
    return proc.stdout.strip()


def _load_plan(chain_id: str) -> dict[str, Any]:
    """Load a chain plan from common local locations.

    Resolution order:
    1) tools/covenant/chains/<chain_id>.plan.json
    2) /tmp/covenant-spawn/<chain_id>.plan.json
    """
    candidates = [
        WORKSPACE_ROOT / "tools" / "covenant" / "chains" / f"{chain_id}.plan.json",
        Path("/tmp/covenant-spawn") / f"{chain_id}.plan.json",
    ]
    for path in candidates:
        if path.exists():
            return json.loads(path.read_text())
    raise FanInError(
        f"Plan not found for chain_id={chain_id}. Expected one of: "
        + ", ".join(str(p) for p in candidates)
    )


def _group_step_ids(plan: dict[str, Any], parallel_group: str) -> set[str]:
    ids: set[str] = set()
    for step in plan.get("steps", []):
        if not isinstance(step, dict):
            continue
        sid = step.get("step_id")
        grp = step.get("parallel_group")
        if isinstance(sid, str) and isinstance(grp, str) and grp.strip() == parallel_group:
            ids.add(sid)
    return ids


def aggregate(chain_id: str, parallel_group: str, db: str = DEFAULT_DB) -> dict[str, Any]:
    """Collect HAB artifacts for the provided chain + parallel group."""
    plan = _load_plan(chain_id)
    group_steps = _group_step_ids(plan, parallel_group)
    if not group_steps:
        raise FanInError(f"No steps found for parallel_group '{parallel_group}'")

    sql = (
        "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.created_at ASC), '[]'::json)::text "
        "FROM ("
        "SELECT id, chain_id, from_agent, to_agent, artifact_type, payload, created_by, consumed_at, created_at "
        "FROM cortana_handoff_artifacts "
        f"WHERE chain_id = '{sql_quote(chain_id)}'::uuid "
        "AND ("
        f"  (payload ? 'parallel_group' AND payload->>'parallel_group' = '{sql_quote(parallel_group)}') "
        f"  OR (payload ? 'step_id' AND payload->>'step_id' IN ({','.join(["'" + sql_quote(s) + "'" for s in sorted(group_steps)])}))"
        ") "
        "ORDER BY created_at ASC"
        ") t;"
    )
    out = run_psql(db, sql)
    artifacts = json.loads(out or "[]")
    return {
        "ok": True,
        "chain_id": chain_id,
        "parallel_group": parallel_group,
        "group_step_ids": sorted(group_steps),
        "artifact_count": len(artifacts),
        "artifacts": artifacts,
    }


def check_barrier(chain_id: str, parallel_group: str, completed_steps: set[str]) -> dict[str, Any]:
    """Return whether every step in the parallel group is complete."""
    plan = _load_plan(chain_id)
    step_ids = sorted(_group_step_ids(plan, parallel_group))
    if not step_ids:
        raise FanInError(f"No steps found for parallel_group '{parallel_group}'")

    completed = group_is_complete(plan, parallel_group, completed_steps)
    pending = sorted(set(step_ids) - set(completed_steps))
    return {
        "ok": True,
        "chain_id": chain_id,
        "parallel_group": parallel_group,
        "group_step_ids": step_ids,
        "completed": completed,
        "pending_step_ids": pending,
    }


def summarize(chain_id: str, parallel_group: str, db: str = DEFAULT_DB) -> dict[str, Any]:
    """Combine grouped artifacts into a unified context block."""
    collected = aggregate(chain_id, parallel_group, db=db)
    artifacts = collected["artifacts"]

    lines = [
        f"Parallel fan-in summary for group '{parallel_group}' (chain {chain_id})",
        f"Artifacts collected: {len(artifacts)}",
        "",
    ]

    for idx, item in enumerate(artifacts, start=1):
        payload = item.get("payload") if isinstance(item, dict) else {}
        summary = None
        risks = None
        if isinstance(payload, dict):
            summary = payload.get("summary")
            risks = payload.get("risks")

        lines.append(f"[{idx}] artifact_id={item.get('id')} type={item.get('artifact_type')} from={item.get('from_agent')}")
        if isinstance(summary, str) and summary.strip():
            lines.append(f"  summary: {summary.strip()}")
        if isinstance(risks, list) and risks:
            lines.append(f"  risks: {', '.join(str(r) for r in risks)}")

    unified = "\n".join(lines).strip()
    return {
        "ok": True,
        "chain_id": chain_id,
        "parallel_group": parallel_group,
        "artifact_count": len(artifacts),
        "context_block": unified,
    }


def _parse_completed_steps(args: argparse.Namespace) -> set[str]:
    if args.completed_json:
        data = json.loads(Path(args.completed_json).read_text())
        if not isinstance(data, list):
            raise FanInError("completed-json must be a JSON array")
        return {str(x) for x in data}
    if args.completed:
        return {x.strip() for x in args.completed.split(",") if x.strip()}
    return set()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Covenant fan-in utilities")
    parser.add_argument("command", choices=["aggregate", "check", "summarize"], help="Operation")
    parser.add_argument("--chain-id", required=True, help="Execution chain UUID")
    parser.add_argument("--group", required=True, help="Parallel group name")
    parser.add_argument("--db", default=DEFAULT_DB, help="PostgreSQL database (default: cortana)")
    parser.add_argument(
        "--completed",
        help="Comma-separated completed step ids (required for check if --completed-json not provided)",
    )
    parser.add_argument(
        "--completed-json",
        help="Path to JSON array file of completed step ids (for check)",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.command == "aggregate":
            print(json.dumps(aggregate(args.chain_id, args.group, db=args.db), indent=2))
            return 0

        if args.command == "check":
            completed = _parse_completed_steps(args)
            print(json.dumps(check_barrier(args.chain_id, args.group, completed), indent=2))
            return 0

        print(json.dumps(summarize(args.chain_id, args.group, db=args.db), indent=2))
        return 0
    except (FanInError, json.JSONDecodeError) as exc:
        print(f"FAN_IN_ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
