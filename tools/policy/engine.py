#!/usr/bin/env python3
"""Autonomy Policy Engine.

Evaluates whether an action can execute autonomously using:
- action policy rules
- budget windows
- risk scoring
- optional temporary overrides
- auditable decision output
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
import json

try:
    import yaml  # type: ignore
except Exception:
    yaml = None


DECISION_ORDER = {"allow": 0, "alert": 1, "ask": 2, "deny": 3}


@dataclass
class ActionRequest:
    action_key: str
    action_category: Optional[str] = None
    operation: Optional[str] = None
    target: Optional[str] = None
    confidence: float = 0.75
    tags: List[str] = field(default_factory=list)
    projected_cost: Dict[str, float] = field(default_factory=dict)  # tokens/api_usd/tool_calls
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Override:
    override_key: str
    decision_override: Optional[str] = None
    max_risk_allowed: Optional[float] = None
    active: bool = True
    starts_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    action_key: Optional[str] = None
    action_category: Optional[str] = None
    budget_adjustments: Dict[str, float] = field(default_factory=dict)

    def applies_to(self, req: ActionRequest, now: datetime) -> bool:
        if not self.active:
            return False
        if self.starts_at and now < self.starts_at:
            return False
        if self.expires_at and now > self.expires_at:
            return False
        if self.action_key and self.action_key != req.action_key:
            return False
        if self.action_category and self.action_category != req.action_category:
            return False
        return True


class PolicyEngine:
    def __init__(self, policy_file: str | Path):
        self.policy_file = Path(policy_file)
        self.policy = self._load_policy()
        self.action_policies = self.policy.get("action_policies", [])
        self.budget_policies = self.policy.get("budget_policies", [])
        self.thresholds = self.policy.get("thresholds", {"low": 35, "medium": 65, "high": 85})
        self.defaults = self.policy.get("defaults", {})
        self.modifiers = self.policy.get("risk_modifiers", {})
        self.immutable_categories = set(self.policy.get("overrides", {}).get("immutable_categories", []))

    def _load_policy(self) -> Dict[str, Any]:
        text = self.policy_file.read_text(encoding="utf-8")
        if yaml is not None:
            return yaml.safe_load(text) or {}
        return json.loads(text)

    def _find_action_policy(self, req: ActionRequest) -> Dict[str, Any]:
        for p in self.action_policies:
            if p.get("key") == req.action_key:
                return p
        if req.action_category:
            for p in self.action_policies:
                if p.get("category") == req.action_category:
                    return p
        raise ValueError(f"No action policy found for key={req.action_key!r} category={req.action_category!r}")

    def _risk_score(self, req: ActionRequest, policy: Dict[str, Any]) -> float:
        score = float(policy.get("risk_base", 0))
        tags = set(req.tags) | set(policy.get("tags", []))

        if "external" in tags:
            score += self.modifiers.get("external", 0)
        if "destructive" in tags:
            score += self.modifiers.get("destructive", 0)
        if "infra" in tags:
            score += self.modifiers.get("infra", 0)
        if "finance" in tags:
            score += self.modifiers.get("finance", 0)
        if "privacy" in tags:
            score += self.modifiers.get("privacy", 0)

        conf = max(0.0, min(1.0, req.confidence or self.defaults.get("confidence_default", 0.75)))
        score += (1.0 - conf) * float(self.defaults.get("risk", {}).get("confidence_penalty_weight", 20))

        if not req.target:
            score += float(self.defaults.get("risk", {}).get("unknown_target_penalty", 10))

        if req.metadata.get("bulk", False):
            score += float(self.defaults.get("risk", {}).get("bulk_operation_penalty", 15))

        max_score = float(self.defaults.get("risk", {}).get("max_score", 100))
        return round(max(0.0, min(max_score, score)), 2)

    def _budget_eval(
        self,
        req: ActionRequest,
        usage_snapshot: Dict[str, float],
        override: Optional[Override] = None,
    ) -> Dict[str, Any]:
        results: List[Dict[str, Any]] = []
        worst_decision = "allow"

        for b in self.budget_policies:
            if not b.get("hard_stop", True) and b.get("on_exceed", "allow") == "allow":
                pass

            scope = b.get("scope", "global")
            scope_value = b.get("scope_value")
            if scope == "category" and scope_value != req.action_category:
                continue
            if scope == "action" and scope_value != req.action_key:
                continue

            cost_type = b.get("cost_type")
            current = float(usage_snapshot.get(cost_type, 0.0))
            projected = float(req.projected_cost.get(cost_type, 0.0))
            limit = float(b.get("limit", 0.0))

            if override and override.budget_adjustments:
                limit += float(override.budget_adjustments.get(cost_type, 0.0))

            next_total = current + projected
            pct = (next_total / limit * 100.0) if limit > 0 else 0.0
            warn_at_pct = float(b.get("warn_at_pct", 80.0))

            status = "ok"
            decision = "allow"
            if pct >= 100:
                status = "exceeded"
                decision = b.get("on_exceed", "ask")
                if b.get("hard_stop", True):
                    decision = "deny" if decision == "deny" else "ask"
            elif pct >= warn_at_pct:
                status = "warn"
                decision = "alert"

            if DECISION_ORDER[decision] > DECISION_ORDER[worst_decision]:
                worst_decision = decision

            results.append(
                {
                    "budget_key": b.get("key"),
                    "cost_type": cost_type,
                    "current": round(current, 4),
                    "projected": round(projected, 4),
                    "next_total": round(next_total, 4),
                    "limit": round(limit, 4),
                    "pct": round(pct, 2),
                    "status": status,
                    "decision": decision,
                }
            )

        return {"decision": worst_decision, "checks": results}

    def _select_override(self, req: ActionRequest, overrides: List[Override], now: datetime) -> Optional[Override]:
        for o in overrides:
            if o.applies_to(req, now):
                return o
        return None

    def evaluate(
        self,
        req: ActionRequest,
        usage_snapshot: Optional[Dict[str, float]] = None,
        overrides: Optional[List[Override]] = None,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        now = now or datetime.now(timezone.utc)
        usage_snapshot = usage_snapshot or {}
        overrides = overrides or []

        action_policy = self._find_action_policy(req)
        req.action_category = req.action_category or action_policy.get("category")

        risk_score = self._risk_score(req, action_policy)
        decision = action_policy.get("base_decision", "ask")
        rationale: List[str] = [f"base:{decision}"]

        if action_policy.get("requires_approval", False):
            decision = max(decision, "ask", key=lambda d: DECISION_ORDER[d])
            rationale.append("requires_approval")

        # Risk threshold escalation
        risk_ask = float(action_policy.get("risk_threshold_ask", self.thresholds.get("medium", 65)))
        risk_deny = float(action_policy.get("risk_threshold_deny", self.thresholds.get("high", 85)))
        if risk_score >= risk_deny:
            decision = max(decision, "deny", key=lambda d: DECISION_ORDER[d])
            rationale.append(f"risk>={risk_deny}")
        elif risk_score >= risk_ask:
            decision = max(decision, "ask", key=lambda d: DECISION_ORDER[d])
            rationale.append(f"risk>={risk_ask}")

        # Budget evaluation
        budget_result = self._budget_eval(req, usage_snapshot)
        if DECISION_ORDER[budget_result["decision"]] > DECISION_ORDER[decision]:
            decision = budget_result["decision"]
            rationale.append(f"budget:{budget_result['decision']}")

        # Override handling
        selected_override = self._select_override(req, overrides, now)
        if selected_override:
            if req.action_category in self.immutable_categories or action_policy.get("immutable", False):
                rationale.append("override_blocked_immutable")
            else:
                if selected_override.max_risk_allowed is not None and risk_score > selected_override.max_risk_allowed:
                    rationale.append("override_max_risk_exceeded")
                else:
                    if selected_override.decision_override:
                        decision = selected_override.decision_override
                        rationale.append(f"override:{selected_override.override_key}")
                    # recompute budget with override adjustments
                    budget_with_override = self._budget_eval(req, usage_snapshot, selected_override)
                    if DECISION_ORDER[budget_with_override["decision"]] > DECISION_ORDER[decision]:
                        decision = budget_with_override["decision"]
                        rationale.append(f"budget_after_override:{budget_with_override['decision']}")
                    budget_result = budget_with_override

        escalation_tier = int(action_policy.get("escalation_tier", 3))
        if decision == "allow" and escalation_tier == 2:
            decision = "alert"
            rationale.append("tier2_alert")

        result = {
            "timestamp": now.isoformat(),
            "action_key": req.action_key,
            "action_category": req.action_category,
            "policy_key": action_policy.get("key"),
            "override_key": selected_override.override_key if selected_override else None,
            "risk_score": risk_score,
            "confidence": req.confidence,
            "decision": decision,
            "escalation_tier": escalation_tier,
            "rationale": ";".join(rationale),
            "budget": budget_result,
            "request": asdict(req),
        }
        return result


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Evaluate a single autonomy policy decision")
    parser.add_argument("--policies", default=str(Path(__file__).with_name("policies.yaml")))
    parser.add_argument("--action-key", required=True)
    parser.add_argument("--category")
    parser.add_argument("--operation")
    parser.add_argument("--target")
    parser.add_argument("--confidence", type=float, default=0.75)
    parser.add_argument("--tags", default="")
    parser.add_argument("--projected", default="{}", help="JSON dict, e.g. '{\"tokens\":1200}'")
    parser.add_argument("--usage", default="{}", help="JSON dict, e.g. '{\"tokens\":50000}'")
    args = parser.parse_args()

    engine = PolicyEngine(args.policies)
    req = ActionRequest(
        action_key=args.action_key,
        action_category=args.category,
        operation=args.operation,
        target=args.target,
        confidence=args.confidence,
        tags=[t.strip() for t in args.tags.split(",") if t.strip()],
        projected_cost=json.loads(args.projected),
    )
    result = engine.evaluate(req, usage_snapshot=json.loads(args.usage))
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
