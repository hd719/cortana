#!/usr/bin/env python3
"""Build Covenant sub-agent prompt with enforced identity contract.

Usage:
  python3 tools/covenant/build_identity_spawn_prompt.py <handshake.json> [--output <path>]
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path("/Users/hd/openclaw")
REGISTRY_PATH = WORKSPACE_ROOT / "agents" / "identities" / "registry.json"
HANDSHAKE_VALIDATOR = WORKSPACE_ROOT / "tools" / "covenant" / "validate_spawn_handshake.py"
FEEDBACK_COMPILER = WORKSPACE_ROOT / "tools" / "covenant" / "feedback_compiler.py"
MEMORY_INJECTOR = WORKSPACE_ROOT / "tools" / "covenant" / "memory_injector.py"

IDENTITY_PROMPT_TEMPLATES = {
    "agent.monitor.v1": "Focus on signal quality, anomaly detection, and actionable triage paths.",
    "agent.huragok.v1": "Focus on implementation safety, resilience, and reproducible execution artifacts.",
    "agent.researcher.v1": "Focus on high-quality source gathering, evidence synthesis, and option comparisons with confidence.",
    "agent.oracle.v1": "Focus on strategic forecasts, risk tradeoffs, and recommendation logic grounded in evidence.",
    "agent.librarian.v1": "Focus on clear documentation structure, durable references, and organized knowledge artifacts.",
}

PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql"
DEFAULT_DB = "cortana"


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


def _agent_role_from_identity(identity_id: str, contract: dict[str, Any]) -> str:
    # Prefer explicit contract role name when it maps clearly; fallback to identity id token.
    role_text = str(contract.get("role", "")).lower()
    for known in ("huragok", "researcher", "librarian", "oracle", "monitor"):
        if known in role_text:
            return known

    parts = identity_id.split(".")
    if len(parts) >= 2:
        return parts[1].lower()
    return "all"


def _feedback_injection_block(agent_role: str, limit: int = 5) -> str:
    if not FEEDBACK_COMPILER.exists():
        return ""

    cmd = ["python3", str(FEEDBACK_COMPILER), "inject", agent_role, "--limit", str(limit)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return ""

    out = result.stdout.strip()
    return out


def _memory_injection_block(agent_role: str, limit: int = 5, max_chars: int = 2000, since_hours: int = 168) -> str:
    if not MEMORY_INJECTOR.exists():
        return ""

    cmd = [
        "python3",
        str(MEMORY_INJECTOR),
        "inject",
        agent_role,
        "--limit",
        str(limit),
        "--max-chars",
        str(max_chars),
        "--since-hours",
        str(since_hours),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return ""

    out = result.stdout.strip()
    return out


def _sql_quote(value: str) -> str:
    return value.replace("'", "''")


def _extract_chain_id(payload: dict[str, Any]) -> str | None:
    direct = payload.get("chain_id")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()

    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        chain_id = metadata.get("chain_id")
        if isinstance(chain_id, str) and chain_id.strip():
            return chain_id.strip()

    return None


def _extract_trace_id(payload: dict[str, Any]) -> str | None:
    direct = payload.get("trace_id")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()

    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        trace_id = metadata.get("trace_id")
        if isinstance(trace_id, str) and trace_id.strip():
            return trace_id.strip()

    return None


def _fetch_handoff_artifacts(chain_id: str, to_agent: str) -> list[dict[str, Any]]:
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.created_at ASC), '[]'::json)::text "
        "FROM ("
        "SELECT id, chain_id, from_agent, to_agent, artifact_type, payload, created_by, created_at "
        "FROM cortana_handoff_artifacts "
        f"WHERE chain_id = '{_sql_quote(chain_id)}'::uuid "
        "AND consumed_at IS NULL "
        f"AND (to_agent IS NULL OR to_agent = '{_sql_quote(to_agent)}') "
        "ORDER BY created_at ASC"
        ") t;"
    )

    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/opt/postgresql@17/bin:" + env.get("PATH", "")

    proc = subprocess.run(
        [PSQL_BIN, DEFAULT_DB, "-X", "-q", "-At", "-c", sql],
        capture_output=True,
        text=True,
        env=env,
    )
    if proc.returncode != 0:
        return []

    try:
        parsed = json.loads((proc.stdout or "").strip() or "[]")
    except json.JSONDecodeError:
        return []

    return parsed if isinstance(parsed, list) else []


def _handoff_artifact_block(payload: dict[str, Any], agent_role: str) -> str:
    chain_id = _extract_chain_id(payload)
    if not chain_id or not agent_role:
        return ""

    artifacts = _fetch_handoff_artifacts(chain_id, agent_role)
    if not artifacts:
        return ""

    compact = [
        {
            "id": a.get("id"),
            "from_agent": a.get("from_agent"),
            "to_agent": a.get("to_agent"),
            "artifact_type": a.get("artifact_type"),
            "created_at": a.get("created_at"),
            "payload": a.get("payload"),
        }
        for a in artifacts
    ]

    return (
        "## Handoff Artifacts (HAB)\n"
        "Use these Cortana-curated upstream artifacts as chain context.\n"
        f"- chain_id: {chain_id}\n"
        f"- recipient_agent: {agent_role}\n"
        f"- artifact_count: {len(compact)}\n\n"
        "```json\n"
        f"{json.dumps(compact, indent=2)}\n"
        "```"
    )


def build_prompt(
    payload: dict[str, Any],
    contract: dict[str, Any],
    feedback_block: str = "",
    memory_block: str = "",
    handoff_block: str = "",
) -> str:
    success_criteria = payload["success_criteria"]
    output_format = payload["output_format"]
    timeout_retry = payload["timeout_retry_policy"]
    callback = payload["callback"]
    constraints = payload.get("constraints", {})
    trace_id = _extract_trace_id(payload)

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
- identity_template: {IDENTITY_PROMPT_TEMPLATES.get(payload['agent_identity_id'], 'Use role-consistent reasoning and deliver contract-compliant outputs.')}

### Tool Permissions (ALLOWLIST — strict)
{_format_bullets(allowed_tools)}

### Hard Boundaries (never violate)
{_format_bullets(hard_boundaries)}

### Escalation Triggers (immediate escalation to Cortana)
{_format_bullets(escalation_triggers)}

{feedback_block if feedback_block else '## Agent Feedback Lessons\n- No role-specific lessons injected for this spawn.'}

{memory_block if memory_block else '## Identity-Scoped Memory Context\n- No role-scoped memories injected for this spawn.'}

{handoff_block if handoff_block else '## Handoff Artifacts (HAB)\n- No unconsumed artifacts injected for this spawn.'}

## Spawn Correlation Metadata
- trace_id: {trace_id if trace_id else 'not provided'}
- chain_id: {_extract_chain_id(payload) if _extract_chain_id(payload) else 'not provided'}

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
- workspace_root: {constraints.get('workspace_root', '/Users/hd/openclaw')}
- allowed_paths: {', '.join(constraints.get('allowed_paths', ['/Users/hd/openclaw']))}
- forbidden_actions: {', '.join(constraints.get('forbidden_actions', [])) if constraints.get('forbidden_actions') else 'none specified'}

## Required Protocol Emission (machine-parseable)
Emit status/completion JSON lines exactly once each (single-line JSON object per line):
- `COVENANT_STATUS_JSON: {{...}}`
- `COVENANT_COMPLETION_JSON: {{...}}`

### Status payload required fields
- state
- confidence
- blockers
- evidence
- next_action

### Completion payload required fields
- summary
- artifacts
- risks
- follow_ups

The lines above are parsed by tooling and must be valid JSON. Do not wrap in markdown.
Use:
- `python3 /Users/hd/openclaw/tools/covenant/validate_agent_protocol.py --type status <status.json>`
- `python3 /Users/hd/openclaw/tools/covenant/validate_agent_protocol.py --type completion <completion.json>`
for pre-flight checks when needed.

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

    agent_role = _agent_role_from_identity(identity_id, contract)
    feedback_block = _feedback_injection_block(agent_role, limit=5)
    memory_block = _memory_injection_block(agent_role, limit=5, max_chars=2000, since_hours=168)
    handoff_block = _handoff_artifact_block(payload, agent_role)

    prompt = build_prompt(
        payload,
        contract,
        feedback_block=feedback_block,
        memory_block=memory_block,
        handoff_block=handoff_block,
    )

    if output_path:
        output_path.write_text(prompt)
        print(f"PROMPT_READY: {output_path}")
    else:
        print(prompt)


if __name__ == "__main__":
    main()
