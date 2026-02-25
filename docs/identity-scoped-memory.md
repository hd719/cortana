# Identity-Scoped Memory Injection

`tools/covenant/memory_injector.py` adds role-aware memory context to Covenant sub-agent spawn prompts.

## Goal

When Cortana spawns an agent, it now injects memories scoped to that agent’s domain:

- `researcher` → research/comparison/analysis/findings/sources
- `oracle` → prediction/strategy/risk/forecast/decision/portfolio
- `huragok` → system/infra/migration/service/build/deploy/fix
- `monitor` → health/alert/anomaly/pattern/incident
- `librarian` → documentation/knowledge/summary/index/catalog

This keeps each agent focused and reduces irrelevant prompt baggage.

## How it works

`memory_injector.py inject <role>` queries both:

- `cortana_memory_episodic`
- `cortana_memory_semantic`

### Selection + scoring

1. Filters to `active = TRUE`
2. Filters by recency window (`since_hours`, default 168h)
3. Filters to role keyword matches in tags/source/body fields
4. Computes score:
   - relevance hits (keyword matches)
   - recency decay boost (newer = higher)
   - native episodic recency weight (`recency_weight`) is respected
5. Sorts by score desc, then recency
6. Truncates by:
   - `limit` item cap (default 5)
   - `max_chars` text budget cap (default 2000)

## CLI

```bash
./tools/covenant/memory_injector.py inject <agent_role> [--limit N] [--max-chars N] [--since-hours N]
```

Example:

```bash
./tools/covenant/memory_injector.py inject huragok --limit 5 --max-chars 2000 --since-hours 168
```

## Prompt integration

`tools/covenant/build_identity_spawn_prompt.py` now:

1. injects AFC lessons (`feedback_compiler.py`)
2. injects identity-scoped memory (`memory_injector.py`) ✅
3. injects HAB artifacts
4. appends mission/task instructions

Placement is intentional: memory appears **after AFC lessons and before mission task instructions**.

## Output shape

Injected section header:

```text
## Identity-Scoped Memory Context
```

Entries include tier/id, snippet, source, timestamp, score, recency, plus truncation note when capped.

## Notes

- If no role-scoped memories are found, a safe fallback line is emitted.
- Injection is context-only, not hard instructions.
- Fail-closed behavior: if injector fails, prompt builder continues with fallback text.
