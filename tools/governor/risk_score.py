#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_POLICY_FILE = Path(__file__).with_name("policy.json")


@dataclass
class GovernorDecision:
    task_id: int | None
    action_type: str
    risk_score: float
    threshold: float
    requires_human_approval: bool
    decision: str  # approved|escalated|denied
    rationale: str
    queued_for_approval: bool
    metadata: dict[str, Any]


class RiskScorer:
    def __init__(self, policy_file: Path = DEFAULT_POLICY_FILE):
        self.policy_file = policy_file
        self.policy = json.loads(policy_file.read_text(encoding="utf-8"))
        self.action_types: dict[str, dict[str, Any]] = self.policy.get("action_types", {})
        self.auto_approve_threshold: float = float(self.policy.get("auto_approve_threshold", 0.5))
        self.default_action_type: str = self.policy.get("default_action_type", "internal-write")
        self.deny_unknown_action_type: bool = bool(self.policy.get("deny_unknown_action_type", True))
        self.command_hints: list[dict[str, str]] = self.policy.get("command_action_hints", [])

    def infer_action_type(self, task: dict[str, Any]) -> str:
        metadata = task.get("metadata") or {}
        exec_meta = metadata.get("exec") or {}

        for key in (
            "action_type",
            "risk_action_type",
        ):
            if metadata.get(key):
                return str(metadata[key])
            if exec_meta.get(key):
                return str(exec_meta[key])

        cmd = str(exec_meta.get("command") or task.get("execution_plan") or "").strip()
        for hint in self.command_hints:
            pattern = hint.get("pattern")
            action_type = hint.get("action_type")
            if not pattern or not action_type:
                continue
            if re.search(pattern, cmd):
                return action_type

        return self.default_action_type

    def evaluate_task(self, task: dict[str, Any], actor: str = "auto-executor") -> GovernorDecision:
        action_type = self.infer_action_type(task)
        policy = self.action_types.get(action_type)
        if not policy:
            if self.deny_unknown_action_type:
                return GovernorDecision(
                    task_id=task.get("id"),
                    action_type=action_type,
                    risk_score=1.0,
                    threshold=self.auto_approve_threshold,
                    requires_human_approval=True,
                    decision="denied",
                    rationale=f"Unknown action_type '{action_type}' and deny_unknown_action_type=true",
                    queued_for_approval=False,
                    metadata={"actor": actor, "policy_version": self.policy.get("version", 1)},
                )
            policy = self.action_types[self.default_action_type]
            action_type = self.default_action_type

        risk_score = float(policy.get("risk_score", 1.0))
        requires_human_approval = bool(policy.get("requires_human_approval", False))

        if requires_human_approval or risk_score >= self.auto_approve_threshold:
            decision = "escalated"
            queued_for_approval = True
            rationale = (
                f"risk={risk_score:.2f} >= threshold={self.auto_approve_threshold:.2f} "
                f"or action explicitly requires human approval"
            )
        else:
            decision = "approved"
            queued_for_approval = False
            rationale = f"risk={risk_score:.2f} < threshold={self.auto_approve_threshold:.2f}; auto-approved"

        return GovernorDecision(
            task_id=task.get("id"),
            action_type=action_type,
            risk_score=risk_score,
            threshold=self.auto_approve_threshold,
            requires_human_approval=requires_human_approval,
            decision=decision,
            rationale=rationale,
            queued_for_approval=queued_for_approval,
            metadata={"actor": actor, "policy_version": self.policy.get("version", 1)},
        )


def _sql_str(value: str) -> str:
    return value.replace("'", "''")


def _run_psql(db: str, sql: str) -> None:
    env = os.environ.copy()
    env["PATH"] = f"/opt/homebrew/opt/postgresql@17/bin:{env.get('PATH', '')}"
    proc = subprocess.run(["psql", db, "-v", "ON_ERROR_STOP=1", "-c", sql], text=True, capture_output=True, env=env)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "psql failed")


def log_decision(db: str, dec: GovernorDecision) -> None:
    metadata_json = _sql_str(json.dumps(dec.metadata, separators=(",", ":")))
    rationale = _sql_str(dec.rationale)
    action_type = _sql_str(dec.action_type)
    decision = _sql_str(dec.decision)

    task_id_sql = "NULL" if dec.task_id is None else str(int(dec.task_id))

    sql = f"""
    INSERT INTO cortana_governor_decisions (
      task_id, action_type, risk_score, threshold, requires_human_approval,
      decision, rationale, queued_for_approval, metadata
    ) VALUES (
      {task_id_sql}, '{action_type}', {dec.risk_score}, {dec.threshold}, {str(dec.requires_human_approval).upper()},
      '{decision}', '{rationale}', {str(dec.queued_for_approval).upper()}, '{metadata_json}'::jsonb
    );
    """
    _run_psql(db, sql)


def update_task_queue_state(db: str, dec: GovernorDecision) -> None:
    if dec.task_id is None or dec.decision != "escalated":
        return

    rationale = _sql_str(f"Queued for human approval by governor: {dec.rationale}")
    sql = f"""
    UPDATE cortana_tasks
    SET status='ready',
        assigned_to='governor',
        outcome='{rationale}',
        metadata = COALESCE(metadata, '{{}}'::jsonb)
            || jsonb_build_object(
                'governor', jsonb_build_object(
                    'decision', '{_sql_str(dec.decision)}',
                    'action_type', '{_sql_str(dec.action_type)}',
                    'risk_score', {dec.risk_score},
                    'threshold', {dec.threshold},
                    'queued_for_approval', true,
                    'evaluated_at', NOW()::text
                )
            )
    WHERE id={int(dec.task_id)};
    """
    _run_psql(db, sql)


def update_task_denied_state(db: str, dec: GovernorDecision) -> None:
    if dec.task_id is None or dec.decision != "denied":
        return

    rationale = _sql_str(f"Denied by governor: {dec.rationale}")
    sql = f"""
    UPDATE cortana_tasks
    SET status='cancelled',
        assigned_to='governor',
        outcome='{rationale}',
        completed_at=NOW(),
        metadata = COALESCE(metadata, '{{}}'::jsonb)
            || jsonb_build_object(
                'governor', jsonb_build_object(
                    'decision', '{_sql_str(dec.decision)}',
                    'action_type', '{_sql_str(dec.action_type)}',
                    'risk_score', {dec.risk_score},
                    'threshold', {dec.threshold},
                    'queued_for_approval', false,
                    'evaluated_at', NOW()::text
                )
            )
    WHERE id={int(dec.task_id)};
    """
    _run_psql(db, sql)


def _task_from_json_arg(raw: str) -> dict[str, Any]:
    task = json.loads(raw)
    if not isinstance(task, dict):
        raise ValueError("task-json must decode to an object")
    return task


def main() -> int:
    parser = argparse.ArgumentParser(description="Autonomy governor v2 risk scorer")
    parser.add_argument("--policy", default=str(DEFAULT_POLICY_FILE))
    parser.add_argument("--db", default="cortana")
    parser.add_argument("--task-json", required=True, help="JSON for a cortana_tasks row")
    parser.add_argument("--actor", default="auto-executor")
    parser.add_argument("--log", action="store_true", help="Persist decision to cortana_governor_decisions")
    parser.add_argument("--apply-task-state", action="store_true", help="Update task state when escalated/denied")
    args = parser.parse_args()

    scorer = RiskScorer(Path(args.policy))
    task = _task_from_json_arg(args.task_json)
    decision = scorer.evaluate_task(task=task, actor=args.actor)

    if args.log:
        log_decision(args.db, decision)

    if args.apply_task_state:
        update_task_queue_state(args.db, decision)
        update_task_denied_state(args.db, decision)

    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "task_id": decision.task_id,
        "action_type": decision.action_type,
        "risk_score": decision.risk_score,
        "threshold": decision.threshold,
        "requires_human_approval": decision.requires_human_approval,
        "decision": decision.decision,
        "rationale": decision.rationale,
        "queued_for_approval": decision.queued_for_approval,
        "metadata": decision.metadata,
    }
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
