# ACP Lane (On-Demand) — Operator Cheat Sheet

## Intent
Use ACP as a specialist coding lane only when explicitly requested.

## Routing Rule
- If user explicitly asks for **Codex**, **Claude Code**, **Gemini**, or **ACP** runtime → route to `agentId: "cortana-acp"`.
- Otherwise use normal sub-agent routing by role.

## Minimal Spawn Template
```json
{
  "agentId": "cortana-acp",
  "label": "cortana-acp-<task-slug>",
  "prompt": "<scoped coding task>"
}
```

## Verification Checklist
- [ ] `config/agent-profiles.json` contains `cortana-acp`.
- [ ] `docs/agent-routing.md` contains explicit ACP routing policy.
- [ ] Non-explicit requests still route through normal Covenant role mapping.
- [ ] ACP lane is used only for coding-runtime-specific requests.

## Smoke Test Flow (manual)
1. **Spawn** ACP run with a tiny scoped task.
2. **Steer** once (clarification or correction) to confirm control path works.
3. **Close** when complete and ensure completion is reported back to parent session.
4. Confirm no default-routing regressions by running one non-ACP task through normal lane.
