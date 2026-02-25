#!/usr/bin/env python3
"""Executor policy engine for Covenant orchestration v2."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

HARD_ESCALATE_FAILURES = {"auth_failure", "permission_denied", "requirements_ambiguous"}
TRANSIENT_FAILURES = {"transient_tool_failure", "network_timeout", "timeout"}

ROUTE_SUGGESTION = {
    "agent.researcher.v1": "agent.oracle.v1",
    "agent.oracle.v1": "agent.librarian.v1",
    "agent.monitor.v1": "agent.huragok.v1",
    "agent.huragok.v1": "agent.monitor.v1",
    "agent.librarian.v1": "agent.huragok.v1",
}


def _step_index(plan: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {s.get("step_id"): s for s in plan.get("steps", []) if isinstance(s, dict) and isinstance(s.get("step_id"), str)}


def _parallel_groups(plan: dict[str, Any]) -> dict[str, set[str]]:
    groups: dict[str, set[str]] = {}
    for step in plan.get("steps", []):
        if not isinstance(step, dict):
            continue
        sid = step.get("step_id")
        grp = step.get("parallel_group")
        if isinstance(sid, str) and isinstance(grp, str) and grp.strip():
            groups.setdefault(grp.strip(), set()).add(sid)
    return groups


def group_for_step(plan: dict[str, Any], step_id: str) -> str | None:
    step = _step_index(plan).get(step_id)
    grp = step.get("parallel_group") if step else None
    return grp.strip() if isinstance(grp, str) and grp.strip() else None


def group_is_complete(plan: dict[str, Any], parallel_group: str, completed_steps: set[str]) -> bool:
    groups = _parallel_groups(plan)
    members = groups.get(parallel_group, set())
    return bool(members) and members.issubset(completed_steps)


def _expanded_dependencies(plan: dict[str, Any], step: dict[str, Any]) -> set[str]:
    """Expand dependencies so any dependency on one member of a parallel group gates on the full group."""
    deps = set(step.get("depends_on", []))
    idx = _step_index(plan)
    groups = _parallel_groups(plan)
    expanded = set(deps)

    for dep in deps:
        dep_step = idx.get(dep)
        grp = dep_step.get("parallel_group") if dep_step else None
        if isinstance(grp, str) and grp.strip() and grp.strip() in groups:
            expanded.update(groups[grp.strip()])

    return expanded


def next_ready_steps(plan: dict[str, Any], completed_steps: set[str]) -> list[dict[str, Any]]:
    """Return dispatch-ready steps.

    - Standard chain: returns one step.
    - Parallel group: when first ready step is in a group, return all ready members in that group.
    """
    steps = [s for s in plan.get("steps", []) if isinstance(s, dict)]
    idx = _step_index(plan)

    for step in steps:
        sid = step.get("step_id")
        if not isinstance(sid, str) or sid in completed_steps:
            continue

        deps = _expanded_dependencies(plan, step)
        if not deps.issubset(completed_steps):
            continue

        grp = step.get("parallel_group")
        if isinstance(grp, str) and grp.strip():
            group_name = grp.strip()
            ready: list[dict[str, Any]] = []
            for member_id, member in idx.items():
                member_group = member.get("parallel_group")
                if member_id in completed_steps:
                    continue
                if not (isinstance(member_group, str) and member_group.strip() == group_name):
                    continue
                member_deps = _expanded_dependencies(plan, member)
                if member_deps.issubset(completed_steps):
                    ready.append(member)
            if ready:
                return ready

        return [step]

    return []


def next_ready_step(plan: dict[str, Any], completed_steps: set[str]) -> dict[str, Any] | None:
    ready = next_ready_steps(plan, completed_steps)
    return ready[0] if ready else None


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
            "dispatch_step_ids": [],
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
            "dispatch_step_ids": [failure_event.get("step_id")] if failure_event.get("step_id") else [],
            "next_action": retry["action"],
            "retry_decision": retry,
        }

    ready_steps = next_ready_steps(plan, completed_steps)
    if not ready_steps:
        return {
            "state": "completed",
            "current_step_id": None,
            "dispatch_step_ids": [],
            "next_action": "final_quality_gate",
            "retry_decision": {"action": "none", "route_to": None, "reason": "All steps complete."},
        }

    dispatch_ids = [s["step_id"] for s in ready_steps if isinstance(s.get("step_id"), str)]
    return {
        "state": "running",
        "current_step_id": dispatch_ids[0] if dispatch_ids else None,
        "dispatch_step_ids": dispatch_ids,
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
