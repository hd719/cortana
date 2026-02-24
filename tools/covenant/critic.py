#!/usr/bin/env python3
"""Critic module for Covenant orchestration v2."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ALLOWED_AGENTS = {
    "agent.monitor.v1",
    "agent.huragok.v1",
    "agent.oracle.v1",
    "agent.librarian.v1",
}

DEFAULT_BUDGET = {
    "max_total_timeout_seconds": 7200,
    "max_total_retries": 8,
}


def review_plan(plan: dict[str, Any], request: dict[str, Any] | None = None) -> dict[str, Any]:
    request = request or {}
    issues: list[str] = []
    warnings: list[str] = []

    steps = plan.get("steps")
    if not isinstance(steps, list) or not steps:
        return {
            "approved": False,
            "requires_human_review": True,
            "issues": ["plan.steps must be a non-empty array"],
            "warnings": [],
            "resource_budget": {"total_timeout_seconds": 0, "total_retries": 0},
        }

    step_ids = {s.get("step_id") for s in steps if isinstance(s, dict)}
    total_timeout = 0
    total_retries = 0

    for idx, step in enumerate(steps):
        if not isinstance(step, dict):
            issues.append(f"steps[{idx}] must be an object")
            continue

        agent = step.get("agent_identity_id")
        if agent not in ALLOWED_AGENTS:
            issues.append(f"steps[{idx}] has unknown agent_identity_id '{agent}'")

        conf = step.get("confidence")
        threshold = step.get("confidence_threshold")
        if not isinstance(conf, (int, float)) or not isinstance(threshold, (int, float)):
            issues.append(f"steps[{idx}] confidence/threshold must be numeric")
        elif conf < threshold:
            issues.append(
                f"steps[{idx}] confidence {conf:.2f} below threshold {threshold:.2f}; requires re-planning or human review"
            )

        deps = step.get("depends_on", [])
        if not isinstance(deps, list):
            issues.append(f"steps[{idx}] depends_on must be an array")
        else:
            for dep in deps:
                if dep not in step_ids:
                    issues.append(f"steps[{idx}] depends_on unknown step_id '{dep}'")

        retry = step.get("retry_policy", {})
        if not isinstance(retry, dict):
            issues.append(f"steps[{idx}] retry_policy must be an object")
            retry = {}

        timeout = retry.get("timeout_seconds", 0)
        retries = retry.get("max_retries", 0)
        if isinstance(timeout, int) and timeout >= 0:
            total_timeout += timeout
        else:
            issues.append(f"steps[{idx}] retry_policy.timeout_seconds must be integer >= 0")
        if isinstance(retries, int) and retries >= 0:
            total_retries += retries
        else:
            issues.append(f"steps[{idx}] retry_policy.max_retries must be integer >= 0")

        gate = step.get("quality_gate", {})
        if not isinstance(gate, dict) or not gate.get("checks"):
            issues.append(f"steps[{idx}] must define a quality_gate with checks")

        handoff = step.get("handoff", {})
        if not isinstance(handoff, dict) or "output_contract" not in handoff:
            issues.append(f"steps[{idx}] must define handoff contract")

    budget_req = request.get("resource_budget") if isinstance(request.get("resource_budget"), dict) else {}
    max_timeout = int(budget_req.get("max_total_timeout_seconds", DEFAULT_BUDGET["max_total_timeout_seconds"]))
    max_retries = int(budget_req.get("max_total_retries", DEFAULT_BUDGET["max_total_retries"]))

    if total_timeout > max_timeout:
        issues.append(f"timeout budget exceeded: {total_timeout}s > {max_timeout}s")
    if total_retries > max_retries:
        issues.append(f"retry budget exceeded: {total_retries} > {max_retries}")

    if len(steps) > int(request.get("max_steps", 6)):
        warnings.append(f"plan uses {len(steps)} steps; exceeds preferred max_steps")

    approved = not issues
    requires_human = any("human review" in i.lower() for i in issues) or not approved

    return {
        "approved": approved,
        "requires_human_review": requires_human,
        "issues": issues,
        "warnings": warnings,
        "resource_budget": {
            "total_timeout_seconds": total_timeout,
            "total_retries": total_retries,
        },
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Critic review for Covenant plan")
    parser.add_argument("plan", help="Path to plan JSON")
    parser.add_argument("--request", help="Path to request JSON", default=None)
    args = parser.parse_args()

    plan = json.loads(Path(args.plan).expanduser().resolve().read_text())
    request = json.loads(Path(args.request).expanduser().resolve().read_text()) if args.request else {}
    print(json.dumps(review_plan(plan, request), indent=2))


if __name__ == "__main__":
    main()
