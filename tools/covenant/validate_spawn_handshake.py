#!/usr/bin/env python3
"""Validate Covenant sub-agent spawn handshake payloads.

Usage:
  python3 tools/covenant/validate_spawn_handshake.py <payload.json>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path("/Users/hd/openclaw")
IDENTITY_REGISTRY_PATH = WORKSPACE_ROOT / "agents" / "identities" / "registry.json"

ALLOWED_FIELDS = {
    "request_id",
    "spawned_by",
    "agent_identity_id",
    "objective",
    "success_criteria",
    "output_format",
    "timeout_retry_policy",
    "callback",
    "constraints",
    "metadata",
}

REQUIRED_FIELDS = {
    "agent_identity_id",
    "objective",
    "success_criteria",
    "output_format",
    "timeout_retry_policy",
    "callback",
}

ALLOWED_CALLBACK_FIELDS = {"update_channel", "final_channel", "heartbeat_interval_seconds", "on_blocked"}
REQUIRED_CALLBACK_FIELDS = {"update_channel"}
ALLOWED_OUTPUT_FORMAT_FIELDS = {"type", "sections"}
REQUIRED_OUTPUT_FORMAT_FIELDS = {"type", "sections"}
ALLOWED_TIMEOUT_FIELDS = {"timeout_seconds", "max_retries", "retry_on", "escalate_on"}
REQUIRED_TIMEOUT_FIELDS = {"timeout_seconds", "max_retries", "retry_on", "escalate_on"}
ALLOWED_CONSTRAINT_FIELDS = {"workspace_root", "allowed_paths", "forbidden_actions"}
ALLOWED_METADATA_FIELDS = {"chain_id", "trace_id"}


def fail(msg: str) -> None:
    print(f"HANDSHAKE_INVALID: {msg}", file=sys.stderr)
    raise SystemExit(1)


def _expect_object(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"'{field}' must be an object")
    return value


def _expect_non_empty_string(value: Any, field: str) -> None:
    if not isinstance(value, str) or not value.strip():
        fail(f"'{field}' must be a non-empty string")


def _expect_non_empty_string_list(value: Any, field: str) -> None:
    if not isinstance(value, list) or not value:
        fail(f"'{field}' must be a non-empty array")
    for idx, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            fail(f"'{field}[{idx}]' must be a non-empty string")


def _load_registry() -> dict[str, Any]:
    if not IDENTITY_REGISTRY_PATH.exists():
        fail(f"identity registry not found: {IDENTITY_REGISTRY_PATH}")
    try:
        registry = json.loads(IDENTITY_REGISTRY_PATH.read_text())
    except json.JSONDecodeError as exc:
        fail(f"identity registry invalid JSON: {exc}")
    if not isinstance(registry, dict):
        fail("identity registry root must be an object")
    agents = registry.get("agents")
    if not isinstance(agents, dict) or not agents:
        fail("identity registry must contain non-empty 'agents' object")
    return registry


def validate(payload: dict[str, Any]) -> None:
    extra = sorted(set(payload.keys()) - ALLOWED_FIELDS)
    if extra:
        fail(f"unsupported field(s): {', '.join(extra)}")

    missing = sorted(REQUIRED_FIELDS - set(payload.keys()))
    if missing:
        fail(f"missing required field(s): {', '.join(missing)}")

    if "request_id" in payload:
        _expect_non_empty_string(payload["request_id"], "request_id")
    if "spawned_by" in payload:
        _expect_non_empty_string(payload["spawned_by"], "spawned_by")

    _expect_non_empty_string(payload["agent_identity_id"], "agent_identity_id")
    registry = _load_registry()
    known_ids = set(registry.get("agents", {}).keys())
    if payload["agent_identity_id"] not in known_ids:
        fail(
            "unknown 'agent_identity_id'. Expected one of: "
            + ", ".join(sorted(known_ids))
        )

    _expect_non_empty_string(payload["objective"], "objective")
    _expect_non_empty_string_list(payload["success_criteria"], "success_criteria")

    output_format = _expect_object(payload["output_format"], "output_format")
    extra_output = sorted(set(output_format.keys()) - ALLOWED_OUTPUT_FORMAT_FIELDS)
    if extra_output:
        fail(f"output_format contains unsupported field(s): {', '.join(extra_output)}")
    missing_output = sorted(REQUIRED_OUTPUT_FORMAT_FIELDS - set(output_format.keys()))
    if missing_output:
        fail(f"output_format missing required field(s): {', '.join(missing_output)}")
    _expect_non_empty_string(output_format["type"], "output_format.type")
    _expect_non_empty_string_list(output_format["sections"], "output_format.sections")

    timeout_retry = _expect_object(payload["timeout_retry_policy"], "timeout_retry_policy")
    extra_timeout = sorted(set(timeout_retry.keys()) - ALLOWED_TIMEOUT_FIELDS)
    if extra_timeout:
        fail(f"timeout_retry_policy contains unsupported field(s): {', '.join(extra_timeout)}")
    missing_timeout = sorted(REQUIRED_TIMEOUT_FIELDS - set(timeout_retry.keys()))
    if missing_timeout:
        fail(f"timeout_retry_policy missing required field(s): {', '.join(missing_timeout)}")

    timeout_seconds = timeout_retry["timeout_seconds"]
    if not isinstance(timeout_seconds, int) or timeout_seconds <= 0:
        fail("'timeout_retry_policy.timeout_seconds' must be a positive integer")

    max_retries = timeout_retry["max_retries"]
    if not isinstance(max_retries, int) or max_retries < 0:
        fail("'timeout_retry_policy.max_retries' must be a non-negative integer")

    _expect_non_empty_string_list(timeout_retry["retry_on"], "timeout_retry_policy.retry_on")
    _expect_non_empty_string_list(timeout_retry["escalate_on"], "timeout_retry_policy.escalate_on")

    callback = _expect_object(payload["callback"], "callback")
    extra_callback = sorted(set(callback.keys()) - ALLOWED_CALLBACK_FIELDS)
    if extra_callback:
        fail(f"callback contains unsupported field(s): {', '.join(extra_callback)}")
    missing_callback = sorted(REQUIRED_CALLBACK_FIELDS - set(callback.keys()))
    if missing_callback:
        fail(f"callback missing required field(s): {', '.join(missing_callback)}")
    _expect_non_empty_string(callback["update_channel"], "callback.update_channel")

    # Optional constraints validation when provided.
    constraints = payload.get("constraints")
    if constraints is not None:
        constraints = _expect_object(constraints, "constraints")
        extra_constraints = sorted(set(constraints.keys()) - ALLOWED_CONSTRAINT_FIELDS)
        if extra_constraints:
            fail(f"constraints contains unsupported field(s): {', '.join(extra_constraints)}")
        if "workspace_root" in constraints:
            _expect_non_empty_string(constraints["workspace_root"], "constraints.workspace_root")
        allowed_paths = constraints.get("allowed_paths")
        if allowed_paths is not None:
            _expect_non_empty_string_list(allowed_paths, "constraints.allowed_paths")
        forbidden_actions = constraints.get("forbidden_actions")
        if forbidden_actions is not None:
            _expect_non_empty_string_list(forbidden_actions, "constraints.forbidden_actions")

    metadata = payload.get("metadata")
    if metadata is not None:
        metadata = _expect_object(metadata, "metadata")
        extra_metadata = sorted(set(metadata.keys()) - ALLOWED_METADATA_FIELDS)
        if extra_metadata:
            fail(f"metadata contains unsupported field(s): {', '.join(extra_metadata)}")
        if "chain_id" in metadata:
            _expect_non_empty_string(metadata["chain_id"], "metadata.chain_id")
        if "trace_id" in metadata:
            _expect_non_empty_string(metadata["trace_id"], "metadata.trace_id")



def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: validate_spawn_handshake.py <payload.json>", file=sys.stderr)
        raise SystemExit(2)

    payload_path = Path(sys.argv[1]).expanduser().resolve()
    if not payload_path.exists():
        fail(f"payload file not found: {payload_path}")

    try:
        payload = json.loads(payload_path.read_text())
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON: {exc}")

    if not isinstance(payload, dict):
        fail("payload root must be an object")

    validate(payload)
    print("HANDSHAKE_VALID")


if __name__ == "__main__":
    main()
