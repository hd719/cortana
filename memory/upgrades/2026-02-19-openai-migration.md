# OpenAI Migration Plan

**Decision date:** Feb 19, 2026
**Status:** Planned (post-Mexico trip, after Feb 22)

## Why
- Single provider for LLM + embeddings (one key, one bill)
- Codex is cheaper than Opus — stretches budget further
- Unlocks memory search (2,500+ files, semantic recall)
- Hamel believes OpenAI is key to our future

## Migration Steps
1. **Re-auth Codex** — `openclaw models auth login --provider openai-codex`
2. **Switch primary model** — Codex as primary, Opus as fallback (transition period)
3. **Set up OpenAI embeddings** — memory search indexes all files + sessions
4. **Update sub-agent model** — switch from Sonnet to OpenAI equivalent
5. **Test everything** — crons, briefs, personality, tool usage, banter
6. **Tune SOUL.md / AGENTS.md** — adjust prompts if tone/behavior shifts
7. **Remove Opus fallback** — once stable, go full OpenAI

## Risks & Mitigations
- **Personality shift** — Cortana's voice is defined in SOUL.md/MEMORY.md, not the model. May need prompt tuning.
- **Reasoning quality** — Opus excels at nuance/multi-step. Monitor for regressions in complex tasks.
- **Tool usage** — Different models handle tool calls differently. Test cron prompts.
- **Cost** — Should decrease significantly. Track via watchdog budget checks.

## What Carries Over (model-independent)
- SOUL.md (personality, dynamic, tone)
- MEMORY.md (all learned context, preferences, rules)
- AGENTS.md (operating procedures)
- All cron jobs, skills, database tables
- The Cortana/Chief partnership

## Success Criteria
- All crons fire without errors for 48h
- Morning briefs quality maintained
- Watchdog/healthchecks pass
- Memory search functional (indexed files > 0)
- Hamel vibes with the output
