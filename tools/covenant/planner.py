#!/usr/bin/env python3
"""Planner module for Covenant orchestration v2."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

AGENT_MONITOR = "agent.monitor.v1"
AGENT_HURAGOK = "agent.huragok.v1"
AGENT_ORACLE = "agent.oracle.v1"
AGENT_LIBRARIAN = "agent.librarian.v1"

HANDOFF_PATTERNS: dict[str, tuple[str, list[str]]] = {
    "oracle_librarian_huragok": (
        "Research/options first, lock implementation contract, then execute.",
        [AGENT_ORACLE, AGENT_LIBRARIAN, AGENT_HURAGOK],
    ),
    "monitor_huragok_monitor": (
        "Detect/triage incident, implement fix, then verify recovery.",
        [AGENT_MONITOR, AGENT_HURAGOK, AGENT_MONITOR],
    ),
    "librarian_huragok_librarian": (
        "Define contract, implement, then align documentation/spec integrity.",
        [AGENT_LIBRARIAN, AGENT_HURAGOK, AGENT_LIBRARIAN],
    ),
}

KEYWORDS = {
    AGENT_MONITOR: {"monitor", "health", "watchdog", "uptime", "budget", "incident", "triage", "verify", "verification"},
    AGENT_HURAGOK: {"implement", "implementation", "code", "fix", "patch", "test", "refactor", "build"},
    AGENT_ORACLE: {"research", "options", "compare", "investigate", "decision", "analysis", "evaluate"},
    AGENT_LIBRARIAN: {"spec", "contract", "runbook", "architecture", "documentation", "doc", "align"},
}

DEFAULT_RETRY = {
    "max_retries": 2,
    "retry_on": ["transient_tool_failure", "network_timeout", "timeout"],
    "escalate_on": ["auth_failure", "permission_denied", "requirements_ambiguous"],
    "timeout_seconds": 1800,
}

DEFAULT_STEP_THRESHOLD = 0.6


def normalize_tokens(payload: dict[str, Any]) -> set[str]:
    tokens: set[str] = set()
    objective = payload.get("objective")
    if isinstance(objective, str):
        for part in objective.lower().replace("→", " ").replace("-", " ").split():
            clean = "".join(c for c in part if c.isalnum() or c == "_")
            if clean:
                tokens.add(clean)

    for key in ("intents", "workflow_type"):
        value = payload.get(key)
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str) and item.strip():
                    tokens.add(item.strip().lower())
        elif isinstance(value, str) and value.strip():
            tokens.add(value.strip().lower())
    return tokens


def choose_pattern(tokens: set[str], explicit: str | None = None) -> tuple[str | None, list[str], str]:
    if explicit:
        key = explicit.strip().lower()
        if key not in HANDOFF_PATTERNS:
            raise ValueError(f"unsupported handoff_pattern '{key}'")
        reason, chain = HANDOFF_PATTERNS[key]
        return key, chain, reason

    has_research = any(t in tokens for t in {"research", "decision", "compare", "evaluate", "analysis"})
    has_spec = any(t in tokens for t in {"spec", "contract", "architecture", "runbook", "documentation", "doc"})
    has_impl = any(t in tokens for t in {"implement", "implementation", "code", "fix", "patch", "build", "test"})
    has_monitor = any(t in tokens for t in {"monitor", "health", "incident", "triage", "verify", "verification", "uptime"})

    if has_research and has_spec and has_impl:
        reason, chain = HANDOFF_PATTERNS["oracle_librarian_huragok"]
        return "oracle_librarian_huragok", chain, reason
    if has_monitor and has_impl:
        reason, chain = HANDOFF_PATTERNS["monitor_huragok_monitor"]
        return "monitor_huragok_monitor", chain, reason
    if has_spec and has_impl:
        reason, chain = HANDOFF_PATTERNS["librarian_huragok_librarian"]
        return "librarian_huragok_librarian", chain, reason

    scores = {agent: len(tokens.intersection(words)) for agent, words in KEYWORDS.items()}
    primary = max(scores, key=scores.get)
    if scores[primary] == 0:
        return None, [AGENT_HURAGOK], "Defaulted to Huragok for execution-oriented fallback when signal is weak."
    reasons = {
        AGENT_MONITOR: "Detected health/triage/run-state signals.",
        AGENT_HURAGOK: "Detected implementation/fix/test signals.",
        AGENT_ORACLE: "Detected research/decision-support signals.",
        AGENT_LIBRARIAN: "Detected spec/contract/documentation signals.",
    }
    return None, [primary], reasons[primary]


def _step_confidence(agent: str, tokens: set[str]) -> float:
    matched = len(tokens.intersection(KEYWORDS.get(agent, set())))
    return round(min(0.95, 0.55 + (matched * 0.08)), 2)


def build_plan(payload: dict[str, Any]) -> dict[str, Any]:
    tokens = normalize_tokens(payload)
    pattern, chain, reason = choose_pattern(tokens, payload.get("handoff_pattern"))

    objective = payload.get("objective", "Execute routed task")
    steps: list[dict[str, Any]] = []
    for i, agent in enumerate(chain, start=1):
        step_id = f"step_{i}"
        deps = [f"step_{i-1}"] if i > 1 else []
        next_step = f"step_{i+1}" if i < len(chain) else None
        steps.append(
            {
                "step_id": step_id,
                "agent_identity_id": agent,
                "objective": objective if i == 1 else f"Continue objective after {deps[0]} outputs",
                "depends_on": deps,
                "confidence": _step_confidence(agent, tokens),
                "confidence_threshold": payload.get("confidence_threshold", DEFAULT_STEP_THRESHOLD),
                "retry_policy": dict(DEFAULT_RETRY),
                "quality_gate": {
                    "name": f"gate_{step_id}",
                    "required": True,
                    "checks": [
                        "outputs_match_contract",
                        "no_boundary_violations",
                        "confidence_meets_threshold",
                    ],
                },
                "handoff": {
                    "input_contract": ["objective", "upstream_artifacts", "constraints"],
                    "output_contract": ["summary", "artifacts", "risks", "confidence"],
                    "deliver_to_step_id": next_step,
                },
            }
        )

    return {
        "version": "covenant-pce-v2",
        "mode": "handoff_chain" if len(chain) > 1 else "single_agent",
        "selected_pattern": pattern,
        "primary_agent_identity_id": chain[0],
        "handoff_chain": chain,
        "routing_reason": reason,
        "steps": steps,
        "quality_gates": {
            "pre_execution": {
                "name": "plan_approved_by_critic",
                "required": True,
                "checks": ["dependencies_acyclic", "budget_within_limits", "agent_selection_valid"],
            },
            "pre_completion": {
                "name": "execution_outputs_validated",
                "required": True,
                "checks": ["all_required_steps_completed", "all_gates_passed", "final_confidence_above_threshold"],
            },
        },
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Build Covenant planner output")
    parser.add_argument("payload", help="Path to routing/planning request JSON")
    args = parser.parse_args()

    payload = json.loads(Path(args.payload).expanduser().resolve().read_text())
    print(json.dumps(build_plan(payload), indent=2))


if __name__ == "__main__":
    main()
