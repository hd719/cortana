#!/usr/bin/env python3
"""Smoke tests for Covenant parallel fan-out/fan-in execution."""

from __future__ import annotations

from executor import build_execution_state
from planner import build_plan


def _approved_critique() -> dict:
    return {
        "approved": True,
        "requires_human_review": False,
        "issues": [],
        "warnings": [],
        "resource_budget": {"total_timeout_seconds": 0, "total_retries": 0},
    }


def run() -> None:
    request = {
        "objective": "Run parallel research on three market angles then synthesize",
        "handoff_pattern": "parallel_research",
        "parallel_research_angles": ["rates", "regulatory", "demand"],
    }
    plan = build_plan(request)
    critique = _approved_critique()

    # 1) Initial dispatch returns all 3 parallel steps.
    s0 = build_execution_state(plan, critique, completed_steps=set())
    assert s0["state"] == "running", s0
    assert s0["dispatch_step_ids"] == ["step_1", "step_2", "step_3"], s0

    # 2) Barrier blocks fan-in while group incomplete.
    s1 = build_execution_state(plan, critique, completed_steps={"step_1"})
    assert s1["dispatch_step_ids"] == ["step_2", "step_3"], s1

    s2 = build_execution_state(plan, critique, completed_steps={"step_1", "step_2"})
    assert s2["dispatch_step_ids"] == ["step_3"], s2

    # 3) Fan-in unlocks only after all 3 complete.
    s3 = build_execution_state(plan, critique, completed_steps={"step_1", "step_2", "step_3"})
    assert s3["dispatch_step_ids"] == ["step_4"], s3

    print("PASS: parallel fan-out/fan-in executor behavior verified")


if __name__ == "__main__":
    run()
