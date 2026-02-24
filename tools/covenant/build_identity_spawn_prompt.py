#!/usr/bin/env python3
"""Build Covenant sub-agent prompt with enforced identity contract.

Usage:
  python3 tools/covenant/build_identity_spawn_prompt.py <handshake.json> [--output <path>]
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path("/Users/hd/clawd")
REGISTRY_PATH = WORKSPACE_ROOT / "agents" / "identities" / "registry.json"
HANDSHAKE_VALIDATOR = WORKSPACE_ROOT / "tools" / "covenant" / "validate_spawn_handshake.py"


def fail(msg: str) -> None:
    print(f"PROMPT_BUILD_INVALID: {msg}", file=sys.stderr)
    raise SystemExit(1)


def _load_json(path: Path, label: str) -> Any:
    if not path.exists():
        fail(f"{label} not found: {path}")
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        fail(f"{label} invalid JSON: {exc}")


def _format_bullets(values: list[str]) -> str:
    return "\n".join(f"- {v}" for v in values)


def build_prompt(payload: dict[str, Any], contract: dict[str, Any]) -> str:
    success_criteria = payload["success_criteria"]
    output_format = payload["output_format"]
    timeout_retry = payload["timeout_retry_policy"]
    callback = payload["callback"]
    constraints = payload.get("constraints", {})

    sections = output_format["sections"]
    allowed_tools = contract["tool_permissions"]
    hard_boundaries = contract["hard_boundaries"]
    escalation_triggers = contract["escalation_triggers"]

    return f"""You are running under Covenant Identity Contract enforcement.

## Identity Contract (authoritative)
- id: {payload['agent_identity_id']}
- name: {contract['name']}
- role: {contract['role']}
- mission_scope: {contract['mission_scope']}
- tone_voice: {contract['tone_voice']}

### Tool Permissions (ALLOWLIST — strict)
{_format_bullets(allowed_tools)}

### Hard Boundaries (never violate)
{_format_bullets(hard_boundaries)}

### Escalation Triggers (immediate escalation to Cortana)
{_format_bullets(escalation_triggers)}

## Mission Objective
{payload['objective']}

## Success Criteria
{_format_bullets(success_criteria)}

## Output Contract
- format: {output_format['type']}
- required_sections: {', '.join(sections)}

## Timeout / Retry Policy
- timeout_seconds: {timeout_retry['timeout_seconds']}
- max_retries: {timeout_retry['max_retries']}
- retry_on: {', '.join(timeout_retry['retry_on'])}
- escalate_on: {', '.join(timeout_retry['escalate_on'])}

## Callback Protocol
- update_channel: {callback['update_channel']}
- final_channel: {callback.get('final_channel', 'requester_session')}
- heartbeat_interval_seconds: {callback.get('heartbeat_interval_seconds', 300)}
- on_blocked: {callback.get('on_blocked', 'immediate')}

## Constraints
- workspace_root: {constraints.get('workspace_root', '/Users/hd/clawd')}
- allowed_paths: {', '.join(constraints.get('allowed_paths', ['/Users/hd/clawd']))}
- forbidden_actions: {', '.join(constraints.get('forbidden_actions', [])) if constraints.get('forbidden_actions') else 'none specified'}

If requirements are ambiguous or conflict with contract boundaries, stop and escalate.

```json
{json.dumps(payload, indent=2)}
```
"""


def main() -> None:
    if len(sys.argv) not in (2, 4):
        print("Usage: build_identity_spawn_prompt.py <handshake.json> [--output <path>]", file=sys.stderr)
        raise SystemExit(2)

    payload_path = Path(sys.argv[1]).expanduser().resolve()

    output_path: Path | None = None
    if len(sys.argv) == 4:
        if sys.argv[2] != "--output":
            print("Usage: build_identity_spawn_prompt.py <handshake.json> [--output <path>]", file=sys.stderr)
            raise SystemExit(2)
        output_path = Path(sys.argv[3]).expanduser().resolve()

    payload = _load_json(payload_path, "handshake payload")
    if not isinstance(payload, dict):
        fail("handshake payload root must be an object")

    # Re-use handshake validator as enforcement gate.
    result = subprocess.run(
        ["python3", str(HANDSHAKE_VALIDATOR), str(payload_path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        err = (result.stderr or result.stdout).strip()
        fail(f"handshake validation failed: {err}")

    registry = _load_json(REGISTRY_PATH, "identity registry")
    if not isinstance(registry, dict) or not isinstance(registry.get("agents"), dict):
        fail("identity registry missing 'agents' object")

    identity_id = payload["agent_identity_id"]
    contract = registry["agents"].get(identity_id)
    if not isinstance(contract, dict):
        fail(f"identity contract not found for {identity_id}")

    prompt = build_prompt(payload, contract)

    if output_path:
        output_path.write_text(prompt)
        print(f"PROMPT_READY: {output_path}")
    else:
        print(prompt)


if __name__ == "__main__":
    main()
