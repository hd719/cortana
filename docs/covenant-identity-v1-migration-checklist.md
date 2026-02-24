# Covenant Identity v1 Migration Checklist

Status date: 2026-02-24
Owner: Huragok (Task #16 / Epic #4)

## Completed
- [x] Enforced handshake validation against identity registry (`validate_spawn_handshake.py`).
- [x] Tightened handshake schema checks (reject unknown top-level and nested fields).
- [x] Enforced identity-based prompt composition (`build_identity_spawn_prompt.py`).
- [x] Added default spawn preparation workflow (`prepare_spawn.py`) that performs:
  - normalization (optional compatibility shim)
  - handshake validation
  - identity prompt generation
- [x] Added compatibility shim for legacy runs (`--legacy-shim`) with safe defaults.
- [x] Kept protocol validation path enforced (`validate_agent_protocol.py --type/--extract`).
- [x] Updated operational docs to use the default prep workflow:
  - `covenant/CORTANA.md`
  - `covenant/README.md`
  - `agents/identities/CONTRACT.md`

## Pending
- [ ] Wire Cortana runtime spawn callsite(s) to invoke `prepare_spawn.py` automatically pre-spawn if that callsite is outside `/Users/hd/clawd` repo scope.

## Verification Commands
```bash
python3 /Users/hd/clawd/tools/covenant/prepare_spawn.py /Users/hd/clawd/tools/covenant/examples/handshake.valid.json --output-dir /tmp/covenant-spawn-e2e-valid
python3 /Users/hd/clawd/tools/covenant/prepare_spawn.py /Users/hd/clawd/tools/covenant/examples/handshake.legacy.json --legacy-shim --output-dir /tmp/covenant-spawn-e2e-legacy
python3 /Users/hd/clawd/tools/covenant/validate_agent_protocol.py --extract /Users/hd/clawd/tools/covenant/examples/protocol-output.valid.txt
```
