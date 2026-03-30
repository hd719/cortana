# Telegram ACP Usage (Current Surface)

## Recommended Flow
1. Use Telegram DM with Cortana (`main`) as the front door.
2. Ask Cortana to run ACP/Codex work.
3. Cortana dispatches to Codex ACP harness target (`agentId: "codex"`).
4. Results are returned to the same Telegram conversation.

## Important Limitation
- Persistent/thread-bound ACP spawn from Telegram is not supported on this surface.
- Do not rely on `--mode persistent --thread auto|here` in Telegram DM.

## Supported Fallbacks
- Use one-shot ACP from Telegram:
  - `/acp spawn codex --mode oneshot --thread off`
- Or run ACP directly from terminal/OpenClaw CLI when persistent/threaded behavior is required.

## Policy Requirement
- ACP policy must target `codex`:
  - `acp.defaultAgent = "codex"`
  - `acp.allowedAgents = ["codex"]`
