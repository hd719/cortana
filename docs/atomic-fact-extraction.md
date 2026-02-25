# Atomic Fact Extraction Pipeline

Task: #131

## What it does

Converts conversation transcripts into **atomic, structured facts** and stores them in `cortana_memory_semantic`.

Fact schema:

```json
{
  "type": "fact|preference|event|system_rule",
  "content": "Hamel prefers 12-hour time format.",
  "tags": ["time-format"],
  "people": ["Hamel Desai"],
  "projects": ["Cortana"],
  "importance": 0.9,
  "confidence": 0.95,
  "supersedes_id": null
}
```

## Files

- `tools/memory/extract_facts.py`
- `tools/memory/prompts/fact_extraction.txt`

## CLI

```bash
# Single input (text file or jsonl). Use - for stdin.
python3 tools/memory/extract_facts.py extract --input <file_or_-> [--dry-run]

# Batch process recent OpenClaw session logs
python3 tools/memory/extract_facts.py batch --since-hours 24 [--dry-run]
```

## Extraction process

1. Build prompt from `tools/memory/prompts/fact_extraction.txt`
2. Call local Ollama model to extract strict JSON facts
3. Validate each fact shape and bounds
4. Embed each fact using local embeddings (`tools/embeddings/embed.py`)
5. Query nearest active facts in `cortana_memory_semantic` using pgvector cosine similarity
6. Apply dedup/supersession policy
7. Insert fact with metadata + embedding

## Dedup & supersession policy

Before insert, nearest similar facts are searched.

- **similarity > 0.95 + identical meaning** → skip as duplicate
- **similarity 0.85–0.95 + updated meaning** → supersede old fact
  - insert new fact with `supersedes_id=<old_id>`
  - mark old row `active=false`, set `superseded_by=<new_id>`, `superseded_at=NOW()`
- **otherwise** → insert as new fact

Similarity search uses local vector index on `embedding_local`.

## Schema support

`extract_facts.py` ensures schema columns exist before processing:

- `fact_type`
- `superseded_by`
- `superseded_at`
- `supersedes_id`
- `extraction_source`
- `embedding_local`

And updates/creates constraints + indexes needed for pgvector lookup.

## Test flow used

```bash
# 1) dry-run extract from sample transcript
python3 tools/memory/extract_facts.py extract --input /tmp/fact-sample.txt --dry-run

# 2) dry-run recent sessions
python3 tools/memory/extract_facts.py batch --since-hours 24 --dry-run
```

If Ollama is unavailable, the command fails fast (so ingestion quality is explicit, not silent).
