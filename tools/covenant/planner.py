#!/usr/bin/env python3
"""Planner module for Covenant orchestration v2."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

AGENT_MONITOR = "agent.monitor.v1"
AGENT_HURAGOK = "agent.huragok.v1"
AGENT_RESEARCHER = "agent.researcher.v1"
AGENT_ORACLE = "agent.oracle.v1"
AGENT_LIBRARIAN = "agent.librarian.v1"

HANDOFF_PATTERNS: dict[str, tuple[str, list[str]]] = {
    "researcher_to_librarian": (
        "Research evidence first, then transform findings into durable documentation.",
        [AGENT_RESEARCHER, AGENT_LIBRARIAN],
    ),
    "researcher_to_oracle": (
        "Gather and compare evidence first, then perform strategic/risk analysis.",
        [AGENT_RESEARCHER, AGENT_ORACLE],
    ),
    "researcher_to_oracle_to_huragok": (
        "Research options, choose strategy, then implement execution changes.",
        [AGENT_RESEARCHER, AGENT_ORACLE, AGENT_HURAGOK],
    ),
    "parallel_research": (
        "Fan-out research across multiple Researchers in parallel, then fan-in to Oracle synthesis.",
        [AGENT_RESEARCHER, AGENT_RESEARCHER, AGENT_RESEARCHER, AGENT_ORACLE],
    ),
    "monitor_to_huragok": (
        "Detect/triage issue patterns, then implement the corrective fix.",
        [AGENT_MONITOR, AGENT_HURAGOK],
    ),
    "librarian_huragok_librarian": (
        "Define contract, implement, then align documentation/spec integrity.",
        [AGENT_LIBRARIAN, AGENT_HURAGOK, AGENT_LIBRARIAN],
    ),
}

KEYWORDS = {
    AGENT_HURAGOK: {
        "build",
        "install",
        "wire",
        "migrate",
        "setup",
        "set",
        "up",
        "deploy",
        "configure",
        "automate",
        "automation",
        "infra",
        "service",
        "daemon",
        "launchd",
        "cron",
        "implement",
        "implementation",
        "code",
        "fix",
        "patch",
        "test",
        "refactor",
    },
    AGENT_RESEARCHER: {
        "research",
        "compare",
        "evaluate",
        "find",
        "investigate",
        "analyze_data",
        "deep_dive",
        "gather",
        "scout",
        "synthesize",
        "sources",
        "synthesize_sources",
        "look_into",
        "what_are_the_options",
        "options",
        "benchmark",
    },
    AGENT_MONITOR: {
        "monitor",
        "alert",
        "detect",
        "anomaly",
        "health",
        "check",
        "health_check",
        "watch",
        "triage",
        "pattern",
        "escalate",
        "uptime",
        "incident",
        "verification",
        "verify",
    },
    AGENT_ORACLE: {
        "forecast",
        "predict",
        "strategy",
        "risk",
        "plan",
        "model",
        "should",
        "we",
        "should_we",
        "tradeoff",
        "decision",
        "advise",
        "scenario",
        "probability",
        "timing",
    },
    AGENT_LIBRARIAN: {
        "document",
        "readme",
        "summarize",
        "index",
        "tag",
        "organize",
        "write",
        "docs",
        "knowledge",
        "base",
        "catalog",
        "spec",
        "contract",
        "runbook",
        "architecture",
        "documentation",
        "doc",
        "align",
    },
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
        objective_lc = objective.lower()
        normalized = (
            objective_lc.replace("→", " ")
            .replace("->", " ")
            .replace("-", " ")
            .replace("/", " ")
        )
        for part in normalized.split():
            clean = "".join(c for c in part if c.isalnum() or c == "_")
            if clean:
                tokens.add(clean)

        phrase_signals = {
            "analyze data": "analyze_data",
            "deep dive": "deep_dive",
            "look into": "look_into",
            "synthesize sources": "synthesize_sources",
            "what are the options": "what_are_the_options",
            "health check": "health_check",
            "should we": "should_we",
            "parallel research": "parallel_research",
            "fan out": "fan_out",
            "fan-out": "fan_out",
            "parallel": "parallel",
        }
        for phrase, token in phrase_signals.items():
            if phrase in objective_lc:
                tokens.add(token)

    for key in ("intents", "workflow_type"):
        value = payload.get(key)
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str) and item.strip():
                    item_normalized = item.strip().lower().replace("-", " ")
                    tokens.update(piece for piece in item_normalized.split() if piece)
        elif isinstance(value, str) and value.strip():
            item_normalized = value.strip().lower().replace("-", " ")
            tokens.update(piece for piece in item_normalized.split() if piece)

    return tokens


def choose_pattern(tokens: set[str], explicit: str | None = None) -> tuple[str | None, list[str], str]:
    if explicit:
        key = explicit.strip().lower()
        if key not in HANDOFF_PATTERNS:
            raise ValueError(f"unsupported handoff_pattern '{key}'")
        reason, chain = HANDOFF_PATTERNS[key]
        return key, chain, reason

    has_research = bool(tokens.intersection(KEYWORDS[AGENT_RESEARCHER]))
    has_oracle = bool(tokens.intersection(KEYWORDS[AGENT_ORACLE]))
    has_spec = bool(tokens.intersection(KEYWORDS[AGENT_LIBRARIAN]))
    has_impl = bool(tokens.intersection(KEYWORDS[AGENT_HURAGOK]))
    has_monitor = bool(tokens.intersection(KEYWORDS[AGENT_MONITOR]))
    has_parallel = bool(tokens.intersection({"parallel", "fan_out", "parallel_research"}))

    if has_parallel and has_research:
        reason, chain = HANDOFF_PATTERNS["parallel_research"]
        return "parallel_research", chain, reason
    if has_research and has_oracle and has_impl:
        reason, chain = HANDOFF_PATTERNS["researcher_to_oracle_to_huragok"]
        return "researcher_to_oracle_to_huragok", chain, reason
    if has_research and has_spec:
        reason, chain = HANDOFF_PATTERNS["researcher_to_librarian"]
        return "researcher_to_librarian", chain, reason
    if has_research and has_oracle:
        reason, chain = HANDOFF_PATTERNS["researcher_to_oracle"]
        return "researcher_to_oracle", chain, reason
    if has_monitor and has_impl:
        reason, chain = HANDOFF_PATTERNS["monitor_to_huragok"]
        return "monitor_to_huragok", chain, reason
    if has_spec and has_impl:
        reason, chain = HANDOFF_PATTERNS["librarian_huragok_librarian"]
        return "librarian_huragok_librarian", chain, reason

    scores = {agent: len(tokens.intersection(words)) for agent, words in KEYWORDS.items()}
    primary = max(scores, key=scores.get)
    if scores[primary] == 0:
        return None, [AGENT_ORACLE], "Weak/ambiguous routing signal; defaulted to Oracle for triage and recommendation."

    reasons = {
        AGENT_MONITOR: "Detected monitoring/health/anomaly signals.",
        AGENT_HURAGOK: "Detected implementation/automation/infrastructure signals.",
        AGENT_RESEARCHER: "Detected research/comparison/evidence-gathering signals.",
        AGENT_ORACLE: "Detected forecasting/risk/decision-modeling signals.",
        AGENT_LIBRARIAN: "Detected documentation/knowledge-organization signals.",
    }
    return None, [primary], reasons[primary]


def _step_confidence(agent: str, tokens: set[str]) -> float:
    matched = len(tokens.intersection(KEYWORDS.get(agent, set())))
    return round(min(0.95, 0.55 + (matched * 0.08)), 2)


def _research_angles(payload: dict[str, Any]) -> list[str]:
    angles = payload.get("parallel_research_angles")
    if isinstance(angles, list):
        normalized = [str(x).strip() for x in angles if str(x).strip()]
        if normalized:
            return normalized
    return ["angle_1", "angle_2", "angle_3"]


def build_plan(payload: dict[str, Any]) -> dict[str, Any]:
    tokens = normalize_tokens(payload)
    pattern, chain, reason = choose_pattern(tokens, payload.get("handoff_pattern"))

    objective = payload.get("objective", "Execute routed task")
    steps: list[dict[str, Any]] = []

    if pattern == "parallel_research":
        angles = _research_angles(payload)
        parallel_group = payload.get("parallel_group") or "research_fanout_1"
        confidence_threshold = payload.get("confidence_threshold", DEFAULT_STEP_THRESHOLD)

        # Fan-out researchers
        for i, angle in enumerate(angles, start=1):
            step_id = f"step_{i}"
            steps.append(
                {
                    "step_id": step_id,
                    "agent_identity_id": AGENT_RESEARCHER,
                    "objective": f"{objective} :: Research angle [{angle}]",
                    "depends_on": [],
                    "parallel_group": parallel_group,
                    "confidence": _step_confidence(AGENT_RESEARCHER, tokens),
                    "confidence_threshold": confidence_threshold,
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
                        "deliver_to_step_id": f"step_{len(angles)+1}",
                    },
                }
            )

        # Fan-in synthesizer depends on one parallel step; executor barrier expands to full group.
        final_step_id = f"step_{len(angles)+1}"
        steps.append(
            {
                "step_id": final_step_id,
                "agent_identity_id": AGENT_ORACLE,
                "objective": f"Synthesize parallel findings for objective: {objective}",
                "depends_on": ["step_1"],
                "parallel_group": None,
                "confidence": _step_confidence(AGENT_ORACLE, tokens),
                "confidence_threshold": confidence_threshold,
                "retry_policy": dict(DEFAULT_RETRY),
                "quality_gate": {
                    "name": f"gate_{final_step_id}",
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
                    "deliver_to_step_id": None,
                },
            }
        )

        chain = [AGENT_RESEARCHER for _ in angles] + [AGENT_ORACLE]
    else:
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
                    "parallel_group": None,
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
