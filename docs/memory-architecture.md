# Cortana Memory Architecture (Unified View)

Date: 2026-02-27  
Related tasks: `cortana_tasks.id IN (281, 282, 283)`

This document explains how Cortanas memory systems fit together across:

- Human-authored markdown files in the `clawd` repo
- PostgreSQL tables in the `cortana` database
- The OpenClaw memory extension using LanceDB (`~/.openclaw/memory/main.sqlite`)
- Local and remote embedding providers (fastembed + OpenAI `text-embedding-3-small`)

It unifies details from:

- `docs/vector-spine.md` (pgvector layer)
- `docs/local-embeddings.md` (local embedding service)
- `memory/research-openclaw-memory-cortex-plane.md` (LanceDB plugin + architecture)

---

## 1. High-level Mental Model

Think in **tiers** and **sources of truth**:

- **Authoritative facts & rules**
  - Markdown in this repo (`MEMORY.md`, `memory/*.md`, `docs/*.md`)
  - Structured tables in PostgreSQL (`cortana_memory_*`, `cortana_patterns`, `cortana_feedback`, tasks, events, etc.)
- **Derived semantic indexes**
  - Postgres `vector` columns (pgvector) on memory tables (see `docs/vector-spine.md`)
  - LanceDB index used by the OpenClaw memory plugin (`~/.openclaw/memory/main.sqlite`)
- **Embedding engines**
  - Local: `~/clawd/tools/embeddings` (fastembed, `BAAI/bge-small-en-v1.5`, 384-dim)
  - Remote: OpenAI `text-embedding-3-small` (1536-dim) via OpenAI API

**Rule of thumb:**

> Markdown + Postgres rows are *ground truth*.
> Vector stores (pgvector, LanceDB) are *derived search indexes*.

All ingestion, consolidation, and recall flows should respect that hierarchy.

---

## 2. Markdown Memory Layer

### 2.1 Files and directories

Key files/directories in this repo:

- `MEMORY.md`
  - Curated long-term memory: identity, preferences, durable rules.
  - Maintained manually in the **main session only**.
- `memory/YYYY-MM-DD.md`
  - Daily logs and operational notes.
  - Current day lives at `memory/<today>.md`; older days get archived under `memory/archive/YYYY/MM/`.
- `memory/archive/YYYY/MM/YYYY-MM-DD.md`
  - Historical daily logs, normalized into year/month subdirectories.
- `memory/research/*.md`
  - Deep dives and architecture research (e.g. `research-openclaw-memory-cortex-plane.md`).
- `memory/fitness/`, `memory/upgrades/`, `memory/mission-plans/`, etc.
  - Topic-focused subtrees for recurring domains (fitness, upgrades, mission plans, etc.).

### 2.2 How markdown is used

Markdown memory serves three roles:

1. **Human-readable ground truth**
   - `MEMORY.md` and daily logs are the canonical place for durable knowledge about Hamel, routines, and behavior.
   - When something "should be remembered", it belongs here first.

2. **Source for database ingestion**
   - The memory ingestion tooling (`tools/memory/ingest_unified_memory.py`) periodically scans recent files (and other sources) to populate Postgres memory tables.
   - This is where a lot of high-signal facts move from free-form text to structured rows.

3. **Anchor for semantic indexing**
   - Markdown content is chunked, embedded, and indexed into both pgvector and LanceDB (directly or via derived forms in Postgres).
   - All vector indexes should remain strictly *derived* from these files or corresponding structured tables.

Archive rules and directory layout are documented in more detail in `memory/README.md` (see Task 283).

---

## 3. PostgreSQL Memory Tables

Postgres (DB `cortana`) holds the structured memory layer. Key tables:

### 3.1 Semantic facts: `cortana_memory_semantic`

From `\d cortana_memory_semantic` (simplified):

- **What it stores**
  - Durable, structured facts and rules, modeled as (subject, predicate, object_value) triples.
  - Types include: `fact`, `preference`, `event`, `system_rule`, `decision`, `rule`, `relationship`.

- **Important fields**
  - `fact_type` (text, constrained to known types)
  - `subject`, `predicate`, `object_value`
  - Confidence / quality: `confidence`, `trust`, `stability`, `fidelity_score`
  - Lifecycle: `first_seen_at`, `last_seen_at`, `active`, `supersedes_id`, `superseded_by`, `superseded_at`
  - Provenance: `source_type`, `source_ref`, `fingerprint`, `extraction_source`, `metadata` (jsonb)
  - Vector fields:
    - `embedding vector(1536)`
    - `embedding_model text`
    - `embedded_at timestamptz`
    - `embedding_local vector(384)` (for local embeddings)
  - Access metadata: `access_count`

- **Indexes**
  - HNSW vector indexes on both `embedding` and `embedding_local` (see `docs/vector-spine.md`).
  - B-tree support indexes for fast filtering by active, subject/predicate, supersession, etc.

**Role:** canonical store of structured semantic knowledge with both remote (OpenAI) and local (fastembed) vector representations.

---

### 3.2 Episodic events: `cortana_memory_episodic`

- **What it stores**
  - Time-stamped episodes from the agents experience: decisions, incidents, notable events.

- **Important fields**
  - `happened_at` (when the event occurred)
  - `summary`, `details`
  - `participants text[]`, `tags text[]`
  - Quality: `salience`, `trust`, `recency_weight`
  - Provenance: `source_type`, `source_ref`, `fingerprint`, `metadata`
  - Vector fields:
    - `embedding vector(1536)`
    - `embedding_model`, `embedded_at`

- **Indexes**
  - HNSW vector index on `embedding`
  - Time and tags indexes for recency and tag-based filters

**Role:** time-oriented episodic memory with semantic search and recency-aware scoring.

---

### 3.3 Procedural memory: `cortana_memory_procedural`

- **What it stores**
  - Playbooks and workflows learned over time ("when X, do Y in these steps").

- **Important fields**
  - `workflow_name`, `trigger_context`
  - `steps_json` (ordered steps)
  - `expected_outcome`
  - `derived_from_feedback_id` (link back to `cortana_feedback` when learned from correction)
  - Quality: `trust`, `success_count`, `failure_count`, last success/failure timestamps
  - Provenance + metadata, and `deprecated` flag

**Role:** distilled habits/runsheets the system can reuse for repeatable tasks, with success/failure stats.

---

### 3.4 Archive + provenance + ingest bookkeeping

- `cortana_memory_archive`
  - Tracks archived semantic/episodic/procedural memories.
  - Fields: `memory_tier` (`episodic` | `semantic` | `procedural`), `memory_id`, `archived_at`, `reason`, `snapshot`, `metadata`.
  - Ensures you can prune active tables while maintaining an audit trail.

- `cortana_memory_provenance`
  - Connects memory entries back to sources (markdown files, events, conversations).
  - Fields: `memory_tier`, `memory_id`, `source_type`, `source_ref`, `source_hash`, `ingest_run_id`, `extractor_version`, `metadata`.

- `cortana_memory_ingest_runs`
  - One row per ingestion batch.
  - Tracks `status` (`running` | `success` | `failed`), counts for inserted rows per tier, errors, and metadata.

- `cortana_memory_consolidation`
  - Tracks higher-level consolidation passes ("dream" or distillation runs).
  - Fields for `days_reviewed`, items strengthened/pruned/archived, feedback clusters, summary/error.

- `cortana_memory_recall_checks`
  - Evaluates recall quality.
  - Fields: `timestamp`, `source`, `prompt`, `expected`, `actual`, `correct`, `metadata`.

Together, these tables encode not just what is remembered, but **how it got there, how it changes, and how well recall is working**.

---

### 3.5 Behavioral patterns and feedback

Two non-`cortana_memory_*` tables feed memory refinement:

- `cortana_patterns`
  - Tracks behavioral patterns (e.g., wake times, workout frequency) with `pattern_type`, `value`, `day_of_week`, `metadata`.
  - Acts as an intermediate statistical memory layer.

- `cortana_feedback`
  - Records human feedback and corrections.
  - Fields: `feedback_type`, `context`, `lesson`, `applied`.
  - Links to procedural and semantic memory via `derived_from_feedback_id` and through ingest/extraction logic.

These are **supporting inputs** into the main semantic/episodic/procedural tiers.

---

## 4. LanceDB Memory Plugin (OpenClaw Extension)

The OpenClaw memory extension (`openclaw-memory-lancedb`) uses **LanceDB** as a local vector store at:

- `~/.openclaw/memory/main.sqlite`

### 4.1 What it stores

The plugin maintains a LanceDB table with (simplified):

- `id`
- `text` (raw memory snippet)
- `vector` (embedding)
- `importance` (numeric)
- `category` (tagging)
- `createdAt` (timestamp)

All of these are **derived** from conversations and, indirectly, from repo files.

### 4.2 How it is used

- **Before a run** (`before_agent_start` hook)
  - Embed the current prompt using **OpenAI** `text-embedding-3-small`.
  - Query LanceDB with `vectorSearch` (top-K) using cosine similarity.
  - Inject high-scoring memories into the system prompt/context.

- **After a run** (`agent_end` hook)
  - Inspect user messages for durable statements using heuristics.
  - Filter out likely prompt injection / instructions.
  - Embed and upsert into LanceDB, deduplicating near-identical memories.

- **Explicit tools**
  - `memory_recall`, `memory_store`, `memory_forget` tools are exposed to agents.

### 4.3 Relationship to Postgres + markdown

- LanceDB is an **operational sidecar index**. It is optimized for speed and convenience, not durability.
- Durable knowledge should either:
  - originate from markdown (`MEMORY.md`, `memory/*.md`) and be ingested into `cortana_memory_*`, or
  - be promoted into Postgres when learned via LanceDB-based auto-capture.

In other words, LanceDB is the **fast recall cache**, while Postgres + markdown remain the **canonical corpus**.

---

## 5. Embedding Engines (Local vs Remote)

There are two primary embedding paths:

### 5.1 Remote OpenAI: `text-embedding-3-small`

Used for:

- `cortana_memory_semantic.embedding` and `cortana_memory_episodic.embedding`
- LanceDB plugin embeddings (OpenClaw memory extension)

Characteristics:

- 1536-dim vectors
- High quality, but requires network/API access
- Backed by the `vector-spine` work documented in `docs/vector-spine.md`

### 5.2 Local embeddings: `tools/embeddings` (fastembed)

Documented in `docs/local-embeddings.md`:

- Venv: `~/clawd/tools/embeddings/.venv`
- Model: `BAAI/bge-small-en-v1.5` (384-dim)
- Entry points:
  - CLI wrapper: `~/clawd/tools/embeddings/embed`
  - Python script: `~/clawd/tools/embeddings/embed.py`
  - Optional HTTP server: `embed serve`

Used for:

- `cortana_memory_semantic.embedding_local` (384-dim vector)
- Any local-only semantic indexing where API usage should be avoided

Rationale:

- Local embeddings provide **zero-API, low-latency recall**, and a fallback when OpenAI is unavailable.
- The combined schema allows either or both embedding providers to be populated.

---

## 6. End-to-End Data Flows

### 6.1 Flow A  From markdown to structured + vector memory

Text diagram:

```text
MEMORY.md, memory/*.md, memory/research/*.md
    |
    |  (periodic ingest: tools/memory/ingest_unified_memory.py)
    v
Extraction & structuring
    |
    +--> cortana_memory_semantic (facts, preferences, rules)
    |        |
    |        +-- embed via OpenAI -> embedding (vector 1536)
    |        +-- embed via fastembed -> embedding_local (vector 384)
    |
    +--> cortana_memory_episodic (events)
             |
             +-- embed via OpenAI -> embedding (vector 1536)

Optional (future / in-progress):
    - Ingestion provenance recorded in cortana_memory_provenance
    - Ingest run metadata in cortana_memory_ingest_runs
```

### 6.2 Flow B  From conversations to LanceDB and back

```text
User messages (Telegram / webchat / other frontends)
    |
    |  (OpenClaw runtime + memory plugin hooks)
    v
OpenClaw memory plugin
    |
    +-- before_agent_start: embed prompt (OpenAI) -> LanceDB search
    |         |
    |         +-- recall top-K memories -> inject into agent context
    |
    +-- agent_end: analyze messages for durable statements
              |
              +-- heuristics + filters
              +-- embed (OpenAI) -> upsert into LanceDB
```

### 6.3 Flow C  Feedback and procedural memory

```text
Human feedback (cortana_feedback)
    |
    v
Procedural extractor / manual promotion
    |
    +--> cortana_memory_procedural
    |        - playbooks, workflows, steps
    |
    +--> cortana_memory_semantic
             - updated facts/preferences

Consolidation passes (cortana_memory_consolidation)
    |
    v
- Strengthen stable memories
- Archive low-value or stale entries -> cortana_memory_archive
```

### 6.4 Flow D  Recall and evaluation

```text
Agent wants context for a task
    |
    +-- Semantic/Episodic recall (pgvector):
    |       SELECT ... ORDER BY embedding <=> $query LIMIT K;
    |
    +-- Local recall (embedding_local) if OpenAI is down
    |
    +-- LanceDB recall (OpenClaw plugin) for conversational context
    |
    v
Merged context fed into LLM prompts

Recall quality evaluation:
    - Expected vs actual recall logged into cortana_memory_recall_checks
    - Patterns over time tracked via cortana_patterns and aggregate queries
```

---

## 7. Coverage Map

Where does each type of information live?

- **Human identity & preferences**
  - Primary: `MEMORY.md`, `USER.md`
  - Derived: `cortana_memory_semantic` (fact_type = `preference` or `relationship`)
  - Indexed: pgvector + LanceDB

- **Daily operations & events**
  - Primary: `memory/YYYY-MM-DD.md`, `memory/archive/...`
  - Derived: `cortana_memory_episodic`, `cortana_events`, `cortana_patterns`
  - Indexed: `cortana_memory_episodic.embedding`, LanceDB (if auto-captured)

- **Procedures / playbooks**
  - Primary: specific markdown files (e.g. docs, playbooks) + `cortana_feedback`
  - Derived: `cortana_memory_procedural`

- **Upgrades, research, and architecture**
  - Primary: `memory/research/*.md`, `docs/*.md`, `memory/upgrades/*`
  - Derived: selected entries into `cortana_memory_semantic` / `cortana_memory_procedural`

- **Feedback and patterns**
  - Primary: `cortana_feedback`, `cortana_patterns`
  - Derived: adjustments to semantic/procedural memories, consolidation decisions.

---

## 8. Known Limitations & Gaps

1. **Incomplete end-to-end extraction pipeline**
   - The desired cortex-plane style extraction system (markdown/events -> semantic/procedural memory with strong supersession) is only partially implemented.
   - `cortana_memory_provenance` and `cortana_memory_ingest_runs` exist, but not all flows populate them consistently.

2. **LanceDB vs Postgres drift risk**
   - LanceDB plugin captures conversational memories independently of the structured ingestion pipeline.
   - Without periodic reconciliation, some high-signal facts may live only in LanceDB and never be promoted into Postgres/markdown.

3. **Dual embedding providers = schema complexity**
   - `cortana_memory_semantic` supports both `embedding` (OpenAI) and `embedding_local` (fastembed).
   - Not all rows are guaranteed to be populated consistently for both; callers must handle missing vectors.

4. **Limited governance for auto-captured memory**
   - Heuristic capture into LanceDB can still pick up noisy or low-importance statements.
   - There is no dedicated review UI yet for curating or promoting LanceDB memories.

5. **Recall evaluation coverage**
   - `cortana_memory_recall_checks` captures tests of recall quality, but there is no automated feedback loop that uses this table to tune thresholds or models.

6. **No single memory console yet**
   - Memory data is spread across markdown, multiple Postgres tables, LanceDB, and local embedding services.
   - Mission Control surfaces only a subset of this; there is no unified UI for browsing all tiers and links.

---

## 9. Design Principles Going Forward

1. **Markdown + Postgres are authoritative; vector stores are indexes.**
   - Every vector entry should have a clear path back to a file or row.
   - Deleting or editing sources should eventually propagate to vector indexes.

2. **Tiered memory with clear responsibilities.**
   - Semantic: timeless facts and preferences.
   - Episodic: time-bound events.
   - Procedural: reusable workflows.
   - LanceDB / plugin: fast conversational recall cache.

3. **Supersession instead of mutation for important facts.**
   - Prefer writing new rows with `supersedes_id` / `superseded_by` over in-place edits.
   - Keep an audit trail of how beliefs evolved.

4. **Local-first resilience.**
   - Maintain `embedding_local` and local fastembed as a fallback when remote APIs fail.
   - Design recall paths that degrade gracefully (local-only, text search, etc.).

5. **Observable memory health.**
   - Use `cortana_memory_consolidation`, `cortana_memory_recall_checks`, and `cortana_patterns` to track how well memory is functioning.
   - Treat recall failures as first-class incidents.

This architecture gives Cortana a coherent, inspectable memory system that spans files, SQL tables, and vector indexes without losing track of whats authoritative.