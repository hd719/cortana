# ACP Lane (On-Demand) — Operator Cheat Sheet

## Intent
Use ACP as a specialist coding lane only when explicitly requested.

## Routing Rule
- If user explicitly asks for **Codex**, **Claude Code**, **Gemini**, or **ACP** runtime → route to ACP harness target `agentId: "codex"`.
- Otherwise use normal sub-agent routing by role.
- Huragok stays native by default for diagnose / patch / review / coordinate.
- Codex ACP is for build / implement / refactor / scaffold / ship.
- Cortana/main is the only ACP dispatcher; Huragok may recommend escalation but does not dispatch ACP directly.

## Minimal Spawn Template
```json
{
  "agentId": "codex",
  "label": "codex-acp-<task-slug>",
  "prompt": "<scoped coding task>"
}
```

## Verification Checklist
- [ ] `config/openclaw.json` has `acp.defaultAgent = "codex"`.
- [ ] `config/openclaw.json` has `acp.allowedAgents = ["codex"]`.
- [ ] `docs/agent-routing.md` contains explicit ACP routing policy.
- [ ] Non-explicit requests still route through normal Covenant role mapping.
- [ ] ACP lane is used only for coding-runtime-specific requests.

## Telegram Surface Note
- Telegram DM is the front door (Cortana/main receives the request first).
- Cortana dispatches ACP work to the Codex harness target (`agentId: "codex"`).
- Do not rely on Telegram persistent/thread-bound ACP spawn on this surface.
- Use one-shot/no-thread ACP (`--mode oneshot --thread off`) or run ACP directly from terminal when needed.

## Smoke Test Flow (manual)
1. **Spawn** ACP run with a tiny scoped task.
2. **Steer** once (clarification or correction) to confirm control path works.
3. **Close** when complete and ensure completion is reported back to parent session.
4. Confirm no default-routing regressions by running one non-ACP task through normal lane.
