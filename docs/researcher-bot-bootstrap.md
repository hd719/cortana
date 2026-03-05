# Researcher Bot Bootstrap (v1)

## Goal
Stand up a dedicated **Researcher** bot/session that the main orchestrator (Cortana) can delegate to for fast investigation work.

## Orchestration Flow
1. Main receives user request.
2. Main delegates scoped research work to Researcher via `sessions_spawn` (or routes by agent id when using CLI helpers).
3. Main can send follow-ups/continuations via `sessions_send` to the same Researcher session.
4. Researcher returns structured findings.
5. Main synthesizes, decides, and sends the final user-facing response.

Main stays the voice. Researcher stays the workbench.

## Researcher Output Contract (enforced in prompt)
Researcher must respond with:
1. **Answer first** (single sentence)
2. **Findings** bullets (3–7)
3. **Confidence** (High/Medium/Low + reason)
4. **Sources** (URLs/doc paths)
5. **Next action** (single concrete recommendation)

### Finance-specific guardrail
For finance/markets/mortgage/investing topics, Researcher must include risk framing and clearly separate data from opinion.

## Dedicated Prompt Template
- File: `config/researcher/default-prompt.md`
- This is intentionally editable so behavior can be tuned without touching scripts.

## Spawn/Start Command
- Script: `tools/researcher/start-researcher.sh`
- Purpose: bootstrap or refresh a persistent Researcher session with codex model (via `researcher` profile).

### Examples
```bash
# Validate command + payload without running
bash tools/researcher/start-researcher.sh --dry-run

# Start (or continue) persistent Researcher session
bash tools/researcher/start-researcher.sh

# Start with run-specific instruction
bash tools/researcher/start-researcher.sh --message "Research current FHA 30-year trend drivers with citations."
```

## Config Notes
Researcher is configured as an explicit agent profile (`id: researcher`) using `openai-codex/gpt-5.3-codex` in:
- `config/agent-profiles.json`
- `config/openclaw.json`

If system config is separate from repo config, mirror these profile changes into `~/.openclaw/openclaw.json` and restart gateway.
