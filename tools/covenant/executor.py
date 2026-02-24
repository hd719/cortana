#!/usr/bin/env python3
"""Executor policy engine for Covenant orchestration v2."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

HARD_ESCALATE_FAILURES = {"auth_failure", "permission_denied", "requirements_ambiguous"}
TRANSIENT_FAILURES = {"transient_tool_failure", "network_timeout", "timeout"}

ROUTE_SUGGESTION = {
    "agent.oracle.v1": "agent.librarian.v1",
    "agent.monitor.v1": "agent.huragok.v1",
    "agent.huragok.v1": "agent.monitor.v1",
    "agent.librarian.v1": "agent.huragok.v1",
}


def next_ready_step(plan: dict[str, Any], completed_steps: set[str]) -> dict[str, Any] | None:
    for step in plan.get("steps", []):
        deps = set(step.get("depends_on", []))
        if deps.issubset(completed_steps) and step.get("step_id") not in completed_steps:
            return step
    return None


def decide_retry(agent_identity_id: str, failure_type: str, attempt: int, max_retries: int) -> dict[str, Any]:
    failure_type = failure_type.strip().lower()

    if failure_type in HARD_ESCALATE_FAILURES:
        return {
            "action": "escalate_immediately",
            "route_to": None,
            "reason": "Hard-blocking failure class; retries are unsafe by policy.",
        }

    if failure_type in TRANSIENT_FAILURES and attempt <= max_retries:
        return {
            "action": "retry_same_agent",
            "route_to": agent_identity_id,
            "reason": "Transient/timeout failure within retry budget.",
        }

    return {
        "action": "escalate_with_route_suggestion",
        "route_to": ROUTE_SUGGESTION.get(agent_identity_id),
        "reason": "Failure exceeded retry budget or non-transient class.",
    }


def build_execution_state(
    plan: dict[str, Any],
    critique: dict[str, Any],
    completed_steps: set[str] | None = None,
    failure_event: dict[str, Any] | None = None,
) -> dict[str, Any]:
    completed_steps = completed_steps or set()

    if not critique.get("approved"):
        return {
            "state": "blocked",
            "current_step_id": None,
            "next_action": "replan_or_human_review",
            "retry_decision": {
                "action": "none",
                "route_to": None,
                "reason": "Critic rejected plan; execution halted before dispatch.",
            },
        }

    if failure_event:
        retry = decide_retry(
            failure_event["agent_identity_id"],
            failure_event["failure_type"],
            int(failure_event["attempt"]),
            int(failure_event["max_retries"]),
        )
        return {
            "state": "blocked" if retry["action"].startswith("escalate") else "running",
            "current_step_id": failure_event.get("step_id"),
            "next_action": retry["action"],
            "retry_decision": retry,
        }

    nxt = next_ready_step(plan, completed_steps)
    if not nxt:
        return {
            "state": "completed",
            "current_step_id": None,
            "next_action": "final_quality_gate",
            "retry_decision": {"action": "none", "route_to": None, "reason": "All steps complete."},
        }

    return {
        "state": "running",
        "current_step_id": nxt["step_id"],
        "next_action": "dispatch_step",
        "retry_decision": {"action": "none", "route_to": None, "reason": "No failure event."},
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Build executor state for Covenant plan")
    parser.add_argument("plan", help="Path to plan JSON")
    parser.add_argument("critique", help="Path to critique JSON")
    parser.add_argument("--completed", help="JSON array file of completed step ids")
    parser.add_argument("--failure", help="Failure event JSON path")
    args = parser.parse_args()

    plan = json.loads(Path(args.plan).expanduser().resolve().read_text())
    critique = json.loads(Path(args.critique).expanduser().resolve().read_text())
    completed: set[str] = set()
    if args.completed:
        completed = set(json.loads(Path(args.completed).expanduser().resolve().read_text()))
    failure = json.loads(Path(args.failure).expanduser().resolve().read_text()) if args.failure else None

    print(json.dumps(build_execution_state(plan, critique, completed, failure), indent=2))


if __name__ == "__main__":
    main()
