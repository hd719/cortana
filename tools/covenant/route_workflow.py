#!/usr/bin/env python3
"""Route Covenant operational workflows with Planner-Critic-Executor (v2).

Usage:
  python3 tools/covenant/route_workflow.py --plan <routing-request.json>
  python3 tools/covenant/route_workflow.py --failure <failure-event.json>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from critic import review_plan
from executor import build_execution_state, decide_retry
from planner import build_plan

ALLOWED_AGENTS = {
    "agent.monitor.v1",
    "agent.huragok.v1",
    "agent.oracle.v1",
    "agent.librarian.v1",
}


class RoutingError(Exception):
    pass


def _load_json(path: Path, label: str) -> dict[str, Any]:
    if not path.exists():
        raise RoutingError(f"{label} not found: {path}")
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise RoutingError(f"{label} invalid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise RoutingError(f"{label} root must be an object")
    return payload


def orchestrate(payload: dict[str, Any]) -> dict[str, Any]:
    plan = build_plan(payload)
    critique = review_plan(plan, payload)
    execution = build_execution_state(plan, critique)
    return {
        "protocol_version": "covenant-pce-v2",
        "request": payload,
        "plan": plan,
        "critique": critique,
        "execution": execution,
    }


def plan_failure(payload: dict[str, Any]) -> dict[str, Any]:
    failure_type = payload.get("failure_type")
    agent_identity_id = payload.get("agent_identity_id")
    attempt = payload.get("attempt")
    max_retries = payload.get("max_retries")

    if not isinstance(failure_type, str) or not failure_type.strip():
        raise RoutingError("failure_type is required")
    if not isinstance(agent_identity_id, str) or agent_identity_id not in ALLOWED_AGENTS:
        raise RoutingError("agent_identity_id must be one of known Covenant identities")
    if not isinstance(attempt, int) or attempt < 1:
        raise RoutingError("attempt must be integer >= 1")
    if not isinstance(max_retries, int) or max_retries < 0:
        raise RoutingError("max_retries must be integer >= 0")

    decision = decide_retry(agent_identity_id, failure_type, attempt, max_retries)
    return {
        "action": decision["action"],
        "state": "blocked" if decision["action"].startswith("escalate") else "in_progress",
        "route_to": decision["route_to"],
        "reason": decision["reason"],
        "required_decision": (
            "Cortana should narrow scope, switch agent, or request human input."
            if decision["action"].startswith("escalate")
            else None
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Route Covenant workflows and failure playbooks")
    parser.add_argument("--plan", help="Path to routing request JSON")
    parser.add_argument("--failure", help="Path to failure-event JSON")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if bool(args.plan) == bool(args.failure):
        print("Usage: route_workflow.py --plan <routing-request.json> | --failure <failure-event.json>", file=sys.stderr)
        raise SystemExit(2)

    try:
        if args.plan:
            payload = _load_json(Path(args.plan).expanduser().resolve(), "routing request")
            result = orchestrate(payload)
            print("ROUTING_PLAN_JSON: " + json.dumps(result, separators=(",", ":"), sort_keys=True))
            return

        payload = _load_json(Path(args.failure).expanduser().resolve(), "failure event")
        result = plan_failure(payload)
        print("ROUTING_FAILURE_PLAN_JSON: " + json.dumps(result, separators=(",", ":"), sort_keys=True))
    except RoutingError as exc:
        print(f"ROUTING_INVALID: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
