# Unified Memory Engine Design

## Tiers
- **Episodic**: timestamped events/conversation snapshots (what happened)
- **Semantic**: distilled facts/preferences/rules (what we know)
- **Procedural**: learned workflows/corrections (how to do things)

## Inputs reviewed
- `AGENTS.md` memory + feedback loop sections
- `HEARTBEAT.md` memory maintenance flow
- `tools/` memory-adjacent scripts (covenant boundary + heartbeat/proprioception hooks)
- `~/.openclaw/openclaw.json` memorySearch config (`sources: memory,sessions`, embedding model `text-embedding-3-small`)
- OpenClaw `memory-wiki` runtime surfaces for imported chat/source ingestion and compiled wiki inspection

## Storage design

### Runtime wiki adjunct (`memory-wiki`)
- Purpose: inspect imported source chats, compiled wiki pages, and source-page drilldown inside Dreaming without turning generated artifacts into repo memory.
- Mode: isolated vault at `~/.openclaw/wiki/cortana`
- UI surfaces: `Imported Insights`, `Memory Palace`, source-page viewer
- Git policy: runtime-owned; do not treat the isolated vault as tracked durable memory
- Promotion rule: if a wiki-derived insight becomes durable truth, promote it deliberately into tracked docs, `MEMORY.md`, or daily memory markdown
- Repo-native refresh path: `/Users/hd/Developer/cortana/tools/openclaw/sync-memory-wiki.sh` ingests the curated `README`/`docs`/`knowledge` front doors from `cortana` and `cortana-external`, then refreshes the topology syntheses

### Episodic (`cortana_memory_episodic`)
- `id`, `happened_at`, `summary`, `details`, `participants[]`, `tags[]`
- Scoring metadata: `salience`, `trust`, `recency_weight`
- Source metadata: `source_type`, `source_ref`, `fingerprint`, `metadata`, `active`

### Semantic (`cortana_memory_semantic`)
- Canonical triple-ish structure: `subject`, `predicate`, `object_value`
- `fact_type` in (`fact`,`preference`,`rule`,`relationship`)
- Quality metadata: `confidence`, `trust`, `stability`
- Lifecycle: `first_seen_at`, `last_seen_at`, `active`, `supersedes_memory_id`

### Procedural (`cortana_memory_procedural`)
- `workflow_name`, `trigger_context`, `steps_json`, `expected_outcome`
- Performance/trust: `trust`, `success_count`, `failure_count`, `last_success_at`, `last_failure_at`
- Lineage: `derived_from_feedback_id`, `source_type`, `source_ref`, `fingerprint`, `deprecated`

### Shared
- `cortana_memory_provenance`: lineage per memory item
- `cortana_memory_ingest_runs`: ingestion run status + counters
- `cortana_memory_archive`: compacted cold memory snapshots

## Ingestion pipeline
Script: `tools/memory/ingest_unified_memory.ts`

Current ingestion hooks:
1. Recent `memory/*.md` files -> episodic entries
2. Recent `cortana_feedback` rows ->
   - episodic (feedback event)
   - semantic (lesson as fact/rule/preference)
   - procedural (correction workflow)
3. Provenance row per inserted item
4. Run log in `cortana_memory_ingest_runs`
5. Update proprioception memory metrics in `cortana_self_model.metadata.memory_engine`

Heartbeat-callable command:
```bash
npx tsx /Users/hd/Developer/cortana/tools/memory/ingest_unified_memory.ts --since-hours 24
```

## Retrieval policy
Tier-aware score:
- `score = w_rel * relevance + w_rec * recency + w_trust * trust`

Weights:
- Episodic: `0.45 rel / 0.35 rec / 0.20 trust`
- Semantic: `0.50 rel / 0.20 rec / 0.30 trust`
- Procedural: `0.35 rel / 0.15 rec / 0.50 trust`

Trust priors:
- Explicit correction/preference: 0.95
- Curated rule/docs: 0.90
- Repeated behavior pattern: 0.75
- Single event extraction: 0.55

## Decay / compaction
- Episodic: archive low-salience items after 90 days
- Semantic: keep long-lived; supersede conflicting facts (`active=false` old row)
- Procedural: retain; deprecate only on repeated failures or supersession
- Archived rows stored in `cortana_memory_archive` with JSON snapshot

## Provenance
Each memory item logs:
- source domain (`daily_markdown`, `feedback`, etc.)
- source reference (`file path`, `feedback:id`)
- fingerprint hash
- ingestion run id
- extractor version

## Phase-1 implementation delivered
- SQL migration adding schema/tables/indexes
- Ingestion script for heartbeat integration
- Proprioception memory health snapshots (event + self_model metadata)
