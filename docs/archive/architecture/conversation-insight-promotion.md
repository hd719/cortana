# Conversation Insight Promotion Pipeline

Task: #137

## Purpose

Automatically promotes durable insights from:
- main session conversation logs
- daily notes (`memory/YYYY-MM-DD.md`)

into `cortana_memory_semantic`, so important context is searchable after session reset.

## Files

- `tools/memory/promote_insights.py`
- `config/launchd/com.cortana.insight-promotion.plist`

## CLI

```bash
# Scan recent main-session user messages
python3 tools/memory/promote_insights.py scan --source session --since-hours 24

# Scan recent daily notes
python3 tools/memory/promote_insights.py scan --source daily-notes --since-hours 24

# Dry-run mode
python3 tools/memory/promote_insights.py scan --source session --since-hours 24 --dry-run

# Promotion analytics by type over time
python3 tools/memory/promote_insights.py stats --days 30
```

## How promotion works

1. Load candidates from source (`session` or `daily-notes`)
2. Classify each candidate with local Ollama `phi3:mini` into:
   - `preference`
   - `decision`
   - `fact`
   - `event`
   - `skip`
3. Build embedding using local embedding tool (`tools/embeddings/embed.py`/`tools/embeddings/embed`)
4. Deduplicate using nearest-neighbor similarity in `cortana_memory_semantic.embedding_local`
5. Insert promoted insight with metadata tags and provenance

## Dedup policy

An insight is skipped when:
- similarity ≥ 0.94 and type+predicate match nearest memory, or
- similarity ≥ 0.975 regardless of predicate, or
- similarity ≥ 0.92 plus high lexical overlap

Otherwise it is promoted/updated via upsert.

## Data shape written to semantic memory

- `fact_type`: one of preference/decision/fact/event
- `subject`, `predicate`, `object_value`
- confidence/trust/stability scores
- `source_type='insight_promotion'`
- `source_ref` pointing to session file or note file
- `metadata` with tags, rationale, source kind, and excerpt
- local embedding for future similarity checks

## Nightly schedule (3:30 AM)

Launchd job:
- Label: `com.cortana.insight-promotion`
- Schedule: daily at `03:30`
- Runs both scans sequentially:
  1. session (last 24h)
  2. daily-notes (last 24h)

### Install / load

```bash
cp /Users/hd/Developer/cortana/config/launchd/com.cortana.insight-promotion.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.cortana.insight-promotion.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.cortana.insight-promotion.plist
launchctl start com.cortana.insight-promotion
```

### Logs

- stdout: `/Users/hd/Developer/cortana/tmp/insight-promotion.stdout.log`
- stderr: `/Users/hd/Developer/cortana/tmp/insight-promotion.stderr.log`
