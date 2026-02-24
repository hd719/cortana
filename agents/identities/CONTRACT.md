# Covenant Identity Contract — Enforcement Addendum (v1)

## Identity Registry (authoritative)
- Registry JSON: `/Users/hd/clawd/agents/identities/registry.json`
- Per-agent contracts:
  - `/Users/hd/clawd/agents/identities/monitor.md`
  - `/Users/hd/clawd/agents/identities/huragok.md`
  - `/Users/hd/clawd/agents/identities/oracle.md`
  - `/Users/hd/clawd/agents/identities/librarian.md`

Spawn payloads must use a known `agent_identity_id` from the registry.

## Memory Boundary Enforcement
- Agent-local scratch: `/Users/hd/clawd/.covenant/agents/<agent_identity_id>/scratch/`
- Only Cortana main may write long-term memory:
  - `/Users/hd/clawd/MEMORY.md`
  - `/Users/hd/clawd/memory/**`
- Cross-agent scratch reads/writes are denied.

Pre-write check command:
```bash
python3 /Users/hd/clawd/tools/covenant/validate_memory_boundary.py <agent_identity_id> <target_path>
```

## Spawn Handshake Enforcement
All sub-agent launches must validate payload schema before spawn.

Default pre-spawn command (required):
```bash
python3 /Users/hd/clawd/tools/covenant/prepare_spawn.py <payload.json> --output-dir /tmp/covenant-spawn
```

Compatibility mode for legacy payload shape (safe shim):
```bash
python3 /Users/hd/clawd/tools/covenant/prepare_spawn.py <legacy-payload.json> --legacy-shim --output-dir /tmp/covenant-spawn
```

Required handshake fields:
- `agent_identity_id`
- `objective`
- `success_criteria`
- `output_format`
- `timeout_retry_policy`
- `callback.update_channel`

Malformed payloads must be rejected and surfaced with `HANDSHAKE_INVALID: ...` errors.

## Spawn Prompt Injection (required)
Build the sub-agent prompt from validated handshake + identity contract:

```bash
python3 /Users/hd/clawd/tools/covenant/build_identity_spawn_prompt.py <payload.json> --output <prompt.txt>
```

This injects into the sub-agent prompt:
- identity metadata (`id/name/role/mission_scope/tone_voice`)
- strict tool allowlist
- hard boundaries
- escalation triggers
- machine-readable handshake JSON footer

Do not launch sub-agents with free-form prompts that skip this step.
