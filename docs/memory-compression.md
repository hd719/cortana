# Semantic Compression Engine: Daily Memory Distillation

## Overview
`tools/memory/compress.ts` distills recent episodic memories (`cortana_memory_episodic`) into compact semantic records (`cortana_memory_semantic`) while preserving:
- key facts
- explicit decisions
- action items

It also computes a **fidelity score** (0.0000-1.0000) by comparing source vs compressed entities/facts.

## What it does
1. Reads recent episodic entries (default: 36h, configurable 24-48h+).
2. Groups related entries by topic/theme using tag+keyword overlap.
3. Generates compressed cluster summaries with sections:
   - `Key facts`
   - `Decisions`
   - `Action items`
4. Runs fidelity checks:
   - extracts source entities (names, task refs, numeric tokens)
   - extracts compressed entities
   - scores overlap ratio
   - applies small penalties if source has decisions/actions that were not retained
5. Writes distilled records to `cortana_memory_semantic` with:
   - `source_type='semantic_compression'`
   - `predicate='daily_distillation'`
   - JSON metadata (entry IDs, entities, facts/decisions/actions)
   - `fidelity_score`

## Schema change
The script ensures this column exists:

```sql
ALTER TABLE cortana_memory_semantic
ADD COLUMN IF NOT EXISTS fidelity_score numeric(5,4);
```

Also enforces check constraint:

```sql
fidelity_score IS NULL OR (fidelity_score >= 0 AND fidelity_score <= 1)
```

## Run manually
```bash
npx tsx /Users/hd/Developer/cortana/tools/memory/compress.ts --since-hours 36
```

Dry run:
```bash
npx tsx /Users/hd/Developer/cortana/tools/memory/compress.ts --since-hours 36 --dry-run
```

## Scheduling (launchd @ 2:00 AM)
Installed plist:
- `/Users/hd/Library/LaunchAgents/com.cortana.memory-compression.plist`

Loaded with launchd label:
- `com.cortana.memory-compression`

Log files:
- `/Users/hd/Developer/cortana/logs/memory-compress.log`
- `/Users/hd/Developer/cortana/logs/memory-compress.err.log`

Common commands:
```bash
# Load / reload
launchctl unload /Users/hd/Library/LaunchAgents/com.cortana.memory-compression.plist 2>/dev/null
launchctl load /Users/hd/Library/LaunchAgents/com.cortana.memory-compression.plist

# Check status
launchctl list | grep com.cortana.memory-compression
```

## Notes
- The compressor uses deterministic heuristics (no external LLM dependency).
- Fidelity is currently entity-overlap-driven; tune extraction rules over time for stricter factual matching.
- Use `--min-cluster-size` if you want to ignore singletons.
