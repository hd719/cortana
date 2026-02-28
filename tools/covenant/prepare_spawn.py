#!/usr/bin/env python3
"""Prepare Covenant spawn payload + prompt using identity v1 defaults.

Default path (enforced):
1) Normalize payload (optional legacy shim)
2) Validate handshake against identity registry
3) Build injected prompt from identity contract

Usage:
  python3 tools/covenant/prepare_spawn.py <handshake-or-legacy.json> [--output-dir <dir>] [--legacy-shim]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path("/Users/hd/openclaw")
HANDSHAKE_VALIDATOR = WORKSPACE_ROOT / "tools" / "covenant" / "validate_spawn_handshake.py"
PROMPT_BUILDER = WORKSPACE_ROOT / "tools" / "covenant" / "build_identity_spawn_prompt.py"
ROUTER = WORKSPACE_ROOT / "tools" / "covenant" / "route_workflow.py"

DEFAULT_OUTPUT_FORMAT = {
    "type": "markdown",
    "sections": ["summary", "changes", "validation", "risks", "next_steps"],
}

DEFAULT_TIMEOUT_RETRY = {
    "timeout_seconds": 1800,
    "max_retries": 2,
    "retry_on": ["transient_tool_failure", "network_timeout"],
    "escalate_on": ["auth_failure", "permission_denied", "requirements_ambiguous"],
}

DEFAULT_CALLBACK = {
    "update_channel": "subagent_result_push",
    "final_channel": "requester_session",
    "heartbeat_interval_seconds": 300,
    "on_blocked": "immediate",
}

DEFAULT_CONSTRAINTS = {
    "workspace_root": str(WORKSPACE_ROOT),
    "allowed_paths": [str(WORKSPACE_ROOT)],
    "forbidden_actions": ["force_push", "destructive_delete", "external_message_without_approval"],
}


class PrepError(Exception):
    pass


def _load_json(path: Path, label: str) -> Any:
    if not path.exists():
        raise PrepError(f"{label} not found: {path}")
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise PrepError(f"{label} invalid JSON: {exc}") from exc


def _to_string_list(value: Any) -> list[str] | None:
    if isinstance(value, list):
        out = [str(v).strip() for v in value if str(v).strip()]
        return out or None
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return None


def normalize_payload(raw: dict[str, Any], legacy_shim: bool) -> tuple[dict[str, Any], list[str]]:
    if not legacy_shim:
        return raw, []

    normalized = dict(raw)
    notes: list[str] = []

    mission = normalized.pop("mission", None)
    expected_outcomes = normalized.pop("expected_outcomes", None)
    expected_outcome = normalized.pop("expected_outcome", None)

    if "objective" not in normalized and isinstance(mission, str) and mission.strip():
        normalized["objective"] = mission.strip()
        notes.append("mapped legacy field 'mission' -> 'objective'")

    if "success_criteria" not in normalized:
        criteria = _to_string_list(expected_outcomes or expected_outcome)
        if criteria:
            normalized["success_criteria"] = criteria
            notes.append("mapped legacy field 'expected_outcome(s)' -> 'success_criteria'")

    if "output_format" not in normalized:
        normalized["output_format"] = dict(DEFAULT_OUTPUT_FORMAT)
        notes.append("injected default 'output_format'")

    if "timeout_retry_policy" not in normalized:
        normalized["timeout_retry_policy"] = dict(DEFAULT_TIMEOUT_RETRY)
        notes.append("injected default 'timeout_retry_policy'")

    if "callback" not in normalized:
        normalized["callback"] = dict(DEFAULT_CALLBACK)
        notes.append("injected default 'callback'")
    elif isinstance(normalized.get("callback"), dict) and "update_channel" not in normalized["callback"]:
        normalized["callback"] = {**DEFAULT_CALLBACK, **normalized["callback"]}
        notes.append("filled missing callback.update_channel via compatibility defaults")

    if "constraints" not in normalized:
        normalized["constraints"] = dict(DEFAULT_CONSTRAINTS)
        notes.append("injected default 'constraints'")

    return normalized, notes


def _run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        msg = (result.stderr or result.stdout).strip()
        raise PrepError(msg or f"command failed: {' '.join(cmd)}")


def maybe_auto_route_identity(payload: dict[str, Any], auto_route: bool) -> tuple[dict[str, Any], list[str]]:
    if not auto_route or payload.get("agent_identity_id"):
        return payload, []

    if not ROUTER.exists():
        raise PrepError(f"routing tool not found: {ROUTER}")

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
        tmp.write(json.dumps(payload))
        tmp_path = Path(tmp.name)

    try:
        result = subprocess.run(
            ["python3", str(ROUTER), "--plan", str(tmp_path)],
            capture_output=True,
            text=True,
        )
    finally:
        tmp_path.unlink(missing_ok=True)

    if result.returncode != 0:
        msg = (result.stderr or result.stdout).strip()
        raise PrepError(f"auto-route failed: {msg}")

    line = None
    for raw in (result.stdout or "").splitlines():
        if raw.startswith("ROUTING_PLAN_JSON:"):
            line = raw[len("ROUTING_PLAN_JSON:") :].strip()
            break
    if not line:
        raise PrepError("auto-route failed: missing ROUTING_PLAN_JSON output")

    try:
        route = json.loads(line)
    except json.JSONDecodeError as exc:
        raise PrepError(f"auto-route failed: invalid routing JSON: {exc}") from exc

    identity = route.get("primary_agent_identity_id")
    if not isinstance(identity, str) or not identity.strip():
        raise PrepError("auto-route failed: missing primary_agent_identity_id")

    updated = dict(payload)
    updated["agent_identity_id"] = identity
    notes = [f"auto-routed missing 'agent_identity_id' -> '{identity}'"]
    return updated, notes


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Prepare Covenant identity-v1 spawn artifacts")
    p.add_argument("payload", help="Path to handshake payload (or legacy payload with --legacy-shim)")
    p.add_argument("--output-dir", default="/tmp/covenant-spawn", help="Directory to write normalized handshake + prompt")
    p.add_argument("--legacy-shim", action="store_true", help="Apply compatibility shim for legacy payload shapes")
    p.add_argument("--auto-route", action="store_true", help="Infer agent_identity_id via route_workflow.py when missing")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    try:
        payload_path = Path(args.payload).expanduser().resolve()
        output_dir = Path(args.output_dir).expanduser().resolve()

        raw = _load_json(payload_path, "payload")
        if not isinstance(raw, dict):
            raise PrepError("payload root must be an object")

        normalized, notes = normalize_payload(raw, args.legacy_shim)
        normalized, route_notes = maybe_auto_route_identity(normalized, args.auto_route)
        notes.extend(route_notes)

        output_dir.mkdir(parents=True, exist_ok=True)
        normalized_path = output_dir / "handshake.normalized.json"
        prompt_path = output_dir / "spawn.prompt.txt"

        normalized_path.write_text(json.dumps(normalized, indent=2) + "\n")

        _run(["python3", str(HANDSHAKE_VALIDATOR), str(normalized_path)])
        _run(["python3", str(PROMPT_BUILDER), str(normalized_path), "--output", str(prompt_path)])

        print(f"SPAWN_PREPARED: {output_dir}")
        print(f"HANDSHAKE_PATH: {normalized_path}")
        print(f"PROMPT_PATH: {prompt_path}")
        if notes:
            print("COMPAT_SHIM_APPLIED:")
            for n in notes:
                print(f"- {n}")
    except PrepError as exc:
        print(f"SPAWN_PREP_INVALID: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
