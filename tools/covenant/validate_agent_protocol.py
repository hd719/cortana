#!/usr/bin/env python3
"""Validate Covenant status/completion protocol payloads.

Usage:
  python3 tools/covenant/validate_agent_protocol.py --type status <payload.json>
  python3 tools/covenant/validate_agent_protocol.py --type completion <payload.json>
  python3 tools/covenant/validate_agent_protocol.py --extract <agent-output.txt>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path("/Users/hd/openclaw")
SCHEMA_PATH = WORKSPACE_ROOT / "agents" / "identities" / "schema.json"
STATUS_PREFIX = "COVENANT_STATUS_JSON:"
COMPLETION_PREFIX = "COVENANT_COMPLETION_JSON:"
KNOWN_IDENTITIES = {
    "agent.monitor.v1",
    "agent.huragok.v1",
    "agent.researcher.v1",
    "agent.oracle.v1",
    "agent.librarian.v1",
}


class ValidationError(Exception):
    pass


def fail(msg: str) -> None:
    print(f"PROTOCOL_INVALID: {msg}", file=sys.stderr)
    raise SystemExit(1)


def _load_json(path: Path, label: str) -> Any:
    if not path.exists():
        raise ValidationError(f"{label} not found: {path}")
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise ValidationError(f"{label} invalid JSON: {exc}") from exc


def _expect_dict(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"'{field}' must be an object")
    return value


def _expect_str(value: Any, field: str, min_len: int = 1) -> None:
    if not isinstance(value, str) or len(value.strip()) < min_len:
        raise ValidationError(f"'{field}' must be a non-empty string")


def _expect_num_range(value: Any, field: str, lo: float, hi: float) -> None:
    if not isinstance(value, (int, float)):
        raise ValidationError(f"'{field}' must be a number")
    v = float(value)
    if v < lo or v > hi:
        raise ValidationError(f"'{field}' must be between {lo} and {hi}")


def _expect_int_min(value: Any, field: str, min_value: int) -> None:
    if not isinstance(value, int) or value < min_value:
        raise ValidationError(f"'{field}' must be an integer >= {min_value}")


def _expect_array(value: Any, field: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValidationError(f"'{field}' must be an array")
    return value


def _expect_array_of_strings(value: Any, field: str) -> None:
    arr = _expect_array(value, field)
    for idx, item in enumerate(arr):
        if not isinstance(item, str) or not item.strip():
            raise ValidationError(f"'{field}[{idx}]' must be a non-empty string")


def _enforce_no_extra(payload: dict[str, Any], allowed: set[str], label: str) -> None:
    extra = sorted(set(payload.keys()) - allowed)
    if extra:
        raise ValidationError(f"{label} contains unsupported field(s): {', '.join(extra)}")


def load_schema_defs() -> dict[str, Any]:
    schema = _load_json(SCHEMA_PATH, "schema")
    if not isinstance(schema, dict):
        raise ValidationError("schema root must be an object")
    defs = schema.get("$defs")
    if not isinstance(defs, dict):
        raise ValidationError("schema missing $defs")
    return defs


def validate_status(payload: dict[str, Any], defs: dict[str, Any]) -> None:
    status_def = _expect_dict(defs.get("status_update"), "$defs.status_update")
    allowed = set(status_def.get("properties", {}).keys())
    required = set(status_def.get("required", []))

    missing = sorted(required - set(payload.keys()))
    if missing:
        raise ValidationError(f"status missing required field(s): {', '.join(missing)}")
    _enforce_no_extra(payload, allowed, "status")

    _expect_str(payload["request_id"], "request_id")
    _expect_str(payload["agent_identity_id"], "agent_identity_id")
    if payload["agent_identity_id"] not in KNOWN_IDENTITIES:
        raise ValidationError("'agent_identity_id' must be a known Covenant identity")

    state = payload["state"]
    allowed_states = set(status_def["properties"]["state"].get("enum", []))
    if not isinstance(state, str) or state not in allowed_states:
        raise ValidationError(f"'state' must be one of: {', '.join(sorted(allowed_states))}")

    _expect_num_range(payload["confidence"], "confidence", 0.0, 1.0)
    _expect_str(payload["timestamp"], "timestamp")

    if "blockers" in payload:
        _expect_array(payload["blockers"], "blockers")
    if "evidence" in payload:
        _expect_array_of_strings(payload["evidence"], "evidence")
    if "next_action" in payload:
        _expect_str(payload["next_action"], "next_action")
    if "eta_seconds" in payload:
        _expect_int_min(payload["eta_seconds"], "eta_seconds", 0)


def validate_completion(payload: dict[str, Any], defs: dict[str, Any]) -> None:
    completion_def = _expect_dict(defs.get("completion"), "$defs.completion")
    allowed = set(completion_def.get("properties", {}).keys())
    required = set(completion_def.get("required", []))

    missing = sorted(required - set(payload.keys()))
    if missing:
        raise ValidationError(f"completion missing required field(s): {', '.join(missing)}")
    _enforce_no_extra(payload, allowed, "completion")

    _expect_str(payload["request_id"], "request_id")
    _expect_str(payload["agent_identity_id"], "agent_identity_id")
    if payload["agent_identity_id"] not in KNOWN_IDENTITIES:
        raise ValidationError("'agent_identity_id' must be a known Covenant identity")

    if payload.get("state") != "completed":
        raise ValidationError("completion 'state' must be 'completed'")

    _expect_str(payload["summary"], "summary")
    _expect_array(payload["artifacts"], "artifacts")
    _expect_array_of_strings(payload["risks"], "risks")
    _expect_array_of_strings(payload["follow_ups"], "follow_ups")
    _expect_num_range(payload["confidence"], "confidence", 0.0, 1.0)
    _expect_str(payload["timestamp"], "timestamp")


def _extract_line_json(text: str, prefix: str) -> dict[str, Any] | None:
    for line in text.splitlines():
        if line.startswith(prefix):
            raw = line[len(prefix) :].strip()
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValidationError(f"invalid JSON after '{prefix}': {exc}") from exc
            if not isinstance(obj, dict):
                raise ValidationError(f"payload after '{prefix}' must be a JSON object")
            return obj
    return None


def validate_extracted(path: Path, defs: dict[str, Any]) -> None:
    if not path.exists():
        raise ValidationError(f"extract file not found: {path}")
    text = path.read_text()

    status = _extract_line_json(text, STATUS_PREFIX)
    completion = _extract_line_json(text, COMPLETION_PREFIX)

    if status is None:
        raise ValidationError(f"missing '{STATUS_PREFIX}' line")
    if completion is None:
        raise ValidationError(f"missing '{COMPLETION_PREFIX}' line")

    validate_status(status, defs)
    validate_completion(completion, defs)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate Covenant status/completion payloads")
    parser.add_argument("payload", nargs="?", help="Path to JSON payload (for --type mode)")
    parser.add_argument("--type", choices=["status", "completion"], help="Payload type")
    parser.add_argument("--extract", help="Path to raw sub-agent output text containing protocol lines")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if bool(args.extract) == bool(args.type):
        print(
            "Usage: validate_agent_protocol.py --type <status|completion> <payload.json>\n"
            "   or: validate_agent_protocol.py --extract <agent-output.txt>",
            file=sys.stderr,
        )
        raise SystemExit(2)

    defs = load_schema_defs()

    try:
        if args.extract:
            validate_extracted(Path(args.extract).expanduser().resolve(), defs)
            print("PROTOCOL_VALID: extracted status/completion payloads")
            return

        if not args.payload:
            raise ValidationError("missing payload path")

        payload_path = Path(args.payload).expanduser().resolve()
        payload = _load_json(payload_path, "payload")
        if not isinstance(payload, dict):
            raise ValidationError("payload root must be an object")

        if args.type == "status":
            validate_status(payload, defs)
            print("STATUS_VALID")
        else:
            validate_completion(payload, defs)
            print("COMPLETION_VALID")
    except ValidationError as exc:
        fail(str(exc))


if __name__ == "__main__":
    main()
