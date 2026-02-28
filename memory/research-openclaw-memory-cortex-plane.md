# Research Brief: openclaw-memory-lancedb + cortex-plane

## 1) Executive Summary

`openclaw-memory-lancedb` is a pragmatic, near-drop-in memory plugin that adds vector retrieval to OpenClaw with minimal moving parts: LanceDB local storage, OpenAI embeddings, lifecycle hooks for auto-recall/auto-capture, and three memory tools (`memory_recall`, `memory_store`, `memory_forget`). It is intentionally simple and opinionated. The design favors speed of adoption over deep memory governance. That makes it a strong **Phase 1 augmentation** candidate for Cortana today, especially for semantic recall across markdown + conversational context.

`cortex-plane` is broader and more ambitious: a full control-plane architecture for persistent agents, job lifecycle, approval gates, memory tiers, extraction pipelines, and operational observability. It contains both implemented components (Qdrant client/scoring, markdown sync engine, lifecycle hydration skeleton, Graphile worker integration) and explicit placeholders (notably extraction task/model pipeline). Its core contribution is not just vector search; it is **memory as an orchestrated system** with durability tiers and operational semantics.

For your current stack (`cortana-external` + `clawd`), the best path is a **hybrid model**: keep PostgreSQL authoritative for structured state/tasks/events, keep markdown as human-ground-truth for identity/behavior memory, and add a vector index (LanceDB now, Qdrant later if needed) as a derived semantic retrieval layer. Do not replace existing systems outright. Add retrieval quality first, then extraction/supersession, then orchestration hardening.

---

## 2) openclaw-memory-lancedb Analysis

### What it does

Repository: `https://github.com/noncelogic/openclaw-memory-lancedb`

Implements an OpenClaw memory plugin (`kind: "memory"`) that:
- Stores memories with embeddings in LanceDB
- Retrieves semantically similar memories and injects them pre-run
- Optionally auto-captures user statements post-run via regex heuristics
- Exposes explicit memory tools + CLI helpers

### Architecture

Core files:
- `index.ts`: plugin runtime, DB wrapper, embeddings wrapper, tools, lifecycle hooks
- `config.ts`: schema + defaults + model dimension mapping
- `openclaw.plugin.json`: plugin manifest
- `README.md`: usage and constraints

High-level flow:

```text
User Prompt
   -> before_agent_start hook
      -> embed(prompt) via OpenAI
      -> LanceDB vectorSearch(top3)
      -> prepend <relevant-memories> context
   -> agent run
   -> agent_end hook (if success)
      -> scan user messages only
      -> heuristic capture filter + injection checks
      -> dedupe (similarity >= 0.95)
      -> store up to 3 memories
```

### API surface

Tools:
- `memory_recall(query, limit=5)`
- `memory_store(text, importance=0.7, category)`
- `memory_forget(query|memoryId)`

CLI:
- `openclaw ltm list`
- `openclaw ltm search <query> --limit`
- `openclaw ltm stats`

### Dependencies

From `package.json`:
- `@lancedb/lancedb`
- `openai`
- `@sinclair/typebox`

Notes:
- Embeddings are OpenAI-only (`text-embedding-3-small` 1536 or `3-large` 3072)
- LanceDB native binding portability can be a real deployment risk (README calls this out)

### Memory data model and retrieval behavior

Stored record fields:
- `id, text, vector, importance, category, createdAt`

Retrieval:
- Uses LanceDB `vectorSearch`
- Treats `_distance` as L2 and maps to similarity `1/(1+d)`
- Filters by `minScore`

Auto-recall threshold defaults in code path:
- top 3 results
- min score ~0.3

Auto-capture behavior:
- User messages only (good anti-self-poisoning guard)
- Heuristic regex triggers
- Length bounded (`captureMaxChars` default 500)
- Hard skip for likely prompt injection strings
- Stores max 3 candidate memories per run

### Strengths

- Very fast to integrate
- Clear safety controls around memory injection and capture
- Gives immediate semantic recall over free text
- Lightweight operations (single local DB path)

### Weaknesses / limitations

- No structured supersession/version chain
- No explicit recency-decay/utility ranking beyond raw similarity
- No metadata-rich schema (people/projects/tags are not first-class)
- Heuristic capture can miss subtle durable facts and capture noisy ones
- Single-provider embedding lock-in (OpenAI)
- LanceDB runtime portability risk on some hosts

### Bottom line for Cortana

Use this design as a **Phase 1 semantic memory accelerator**, but do not stop here. It’s great glue; not a full memory cognition system.

---

## 3) cortex-plane Spec Analysis

### What it is

Repository: `https://github.com/noncelogic/cortex-plane`

This is a platform blueprint plus partial implementation for agent orchestration with:
- Control plane + worker model
- Job state machine + approvals/checkpoints
- Tiered memory architecture
- File-to-vector memory sync
- Planned extraction pipeline

### Architecture concepts most relevant to memory/cognition

#### A) Three-tier memory model

From `docs/spec.md`:
1. Working memory (LLM context)
2. Session buffer (JSONL events on disk/PVC)
3. Long-term semantic memory (Qdrant)

This is the strongest conceptual contribution: **separate ephemeral reasoning, durable replay, and semantic memory index.**

#### B) Rich memory schema + ranking logic

Spec/schema patterns include:
- `type`, `tags`, `people`, `projects`, `importance`, `confidence`, `supersedesId`
- composite ranking with similarity + recency decay + utility/access

In code (`packages/shared/src/memory/scoring.ts`), this is already partially implemented with type-specific half-lives and weighted scoring.

#### C) Markdown-authoritative sync

Spec + spike (`docs/spikes/032-memory-sync.md`) and code (`packages/shared/src/memory/sync/*`) support:
- Structured markdown chunking (`##` section aware)
- Content hashing (SHA-256)
- Deterministic IDs for idempotent upserts
- File watcher + debounce
- Deletion propagation (remove orphaned vector entries)
- Human-wins philosophy

This maps extremely well to `clawd`’s MEMORY.md + daily logs model.

#### D) Extraction pipeline (important but currently placeholder)

Spec section describes robust batch extraction with validation/dedupe/supersession; however code in `packages/control-plane/src/worker/tasks/memory-extract.ts` is explicitly placeholder/no-op today.

Interpretation: architecture is strong, implementation maturity is mixed.

### Implementation maturity snapshot (important)

Implemented:
- Qdrant client wrapper and scoring (`packages/shared/src/memory/client.ts`, `scoring.ts`)
- Markdown sync engine (`chunker.ts`, `state.ts`, `sync.ts`, `watcher.ts`)
- Control-plane infra skeleton (Fastify + Graphile + migrations)

Not fully implemented:
- Full extraction LLM pipeline (spec’d, not shipped)
- End-to-end production “cognition loop” as described in spec

### Bottom line for Cortana

Treat cortex-plane as a **design reference + selective code donor**, not a drop-in replacement. Adopt the memory architecture principles first; selectively import implementation patterns that fit your current stack.

---

## 4) Integration Opportunities for cortana-external

Current target: `/Users/hd/Developer/cortana-external`

### Current state (observed)

- Mission Control Next.js app with Prisma (`apps/mission-control`)
- Core operational tables + mirrored `cortana_tasks` / `cortana_epics`
- Cortana primary DB already has many operational memory-like tables (events, patterns, feedback, tasks, etc.)

This system is excellent at structured operations but weak at semantic free-text recall across notes/conversations.

### Opportunity 1 — Add vector sidecar memory (augment, don’t replace)

**Recommendation:** Add `cortana_memories` (metadata) + LanceDB/Qdrant vector index.

Text architecture:

```text
PostgreSQL (authoritative structured state)
  - cortana_tasks, cortana_events, cortana_feedback, etc.
  - new: cortana_memories (metadata pointers)
        |
        +--> Vector Index (LanceDB now OR Qdrant)
              - embedding vector
              - semantic retrieval

App/services query both:
1) deterministic SQL filters
2) semantic top-k recall
3) merge/rerank results
```

Concrete files to add/change:
- `apps/mission-control/prisma/schema.prisma`
  - add `CortanaMemory` model (id, type, content, source, tags, people, projects, importance, confidence, supersedesId, createdAt, lastAccessedAt, accessCount, hash)
- `apps/mission-control/prisma/migrations/...`
  - migration for new memory metadata table + indexes
- `apps/mission-control/lib/` (new)
  - `memory-embed.ts` (provider abstraction)
  - `memory-index-lancedb.ts` (or `memory-index-qdrant.ts`)
  - `memory-search.ts` (hybrid SQL + vector retrieval)
- `apps/mission-control/app/api/memory/search/route.ts` (new)
- `apps/mission-control/app/memory/page.tsx` (optional UI)

Effort vs payoff:
- Effort: Medium
- Payoff: High (immediate recall quality jump)

### Opportunity 2 — Adopt cortex-style scoring over raw similarity

Use weighted score:
- similarity + recency + utility (+ optionally importance)

Files:
- `apps/mission-control/lib/memory-rank.ts` (new)
- Use in API route + dashboard surfaces

Effort: Low
Payoff: Medium-High (better relevance ranking)

### Opportunity 3 — Extraction pipeline for event/task logs

Extract durable facts/preferences/rules from:
- `cortana_events.message`
- `cortana_feedback.lesson`
- selected task outcomes

Pipeline:

```text
Event/task ingest -> batch extraction job -> schema validation -> dedupe/supersession -> embed -> upsert index
```

Files/services:
- `watchdog/` or separate worker service in repo root
- new script/job runner (Node or Python) scheduled (cron/launchd)

Effort: Medium-High
Payoff: High over time

### Opportunity 4 — Approval gates concept for risky automation

Borrow cortex-plane approval-gate semantics for high-risk actions in Mission Control workflows.

Effort: Medium
Payoff: Medium (safety + auditability)

### Migration path for cortana-external

1. Add metadata table + vector index abstraction
2. Index existing MEMORY.md + selected logs (read-only bootstrap)
3. Add search endpoint; wire one dashboard panel
4. Add extractor batches and supersession chain
5. Add approval gates for selected external actions

---

## 5) Integration Opportunities for clawd workspace

Current target: `/Users/hd/openclaw`

### Current state

- Human-authoritative markdown memory (`MEMORY.md`, `memory/YYYY-MM-DD.md`, research notes)
- Operational rules in AGENTS/SOUL/TOOLS
- PostgreSQL tables in Cortana DB for structured long-term machine memory

This is ideal for cortex-style markdown sync + semantic index.

### Opportunity 1 — File-authoritative semantic index for markdown memory

Adopt Spike-32 style sync behavior directly for `clawd`:
- Chunk markdown by headings
- Hash + deterministic IDs
- Upsert changed chunks only
- Delete removed chunks
- Keep markdown authoritative

Text diagram:

```text
FILES (authoritative)
  MEMORY.md
  memory/*.md
  memory/research/*.md
      |
      v
Chunk + Hash + Diff
      |
      v
Vector Index (LanceDB initially)
      |
      v
memory_search tool returns ranked context
```

Concrete files to create in `clawd`:
- `tools/memory_index/ingest.py` or `.ts`
- `tools/memory_index/chunker.py`
- `tools/memory_index/state.json` (generated)
- `skills/memory-index/SKILL.md` (new)
- Optional: `tools/memory_index/search.py`

And update:
- `AGENTS.md` (memory maintenance protocol references semantic index availability)
- `TOOLS.md` (add memory index operational commands)

Effort: Medium
Payoff: Very High

### Opportunity 2 — Replace/augment current memory_search behavior

**Answer:** Yes, LanceDB vector search can augment and potentially replace naive memory search.

Recommended strategy:
- Short term: augment (vector results + file path anchors)
- Long term: replace only if deterministic lookup parity is preserved

Hybrid retrieval policy:
1. SQL/structured recall for exact fields/tasks/events
2. Vector recall for semantic free-text
3. Merge + rerank

### Opportunity 3 — Cortex concepts for The Covenant (sub-agent framework)

Most valuable imports:
- Tiered memory distinction (working/session/long-term)
- Event buffer semantics for sub-agent traceability
- Checkpoint + resume semantics for long tasks
- Explicit approval gates for risky operations

Suggested concrete additions in `clawd`:
- `memory/subagent-traces/` JSONL buffer per delegated task
- extraction pass that writes durable lessons to memory index + `cortana_feedback`
- structured “supersedes” chain when preferences/rules are updated

Effort: Medium-High
Payoff: High (better continuity, fewer repeated mistakes)

### Opportunity 4 — Human-wins lock semantics in local memory editing

When both automation and human edits are possible, always keep file truth as source.

This aligns with your current operating style and avoids memory drift.

---

## 6) Recommended Action Plan (prioritized)

### Phase 0 (1-2 days): Foundation decisions

1. Decide vector backend for v1:
   - Start LanceDB for local simplicity, or
   - Start Qdrant if you want containerized multi-service scale immediately
2. Lock memory schema v1 (minimum fields + supersedesId)

### Phase 1 (3-5 days): `clawd` semantic memory upgrade

1. Implement markdown chunk/hash/diff pipeline over:
   - `MEMORY.md`
   - `memory/*.md`
   - `memory/research/*.md`
2. Build `memory_search` CLI/tool wrapper with ranked outputs and source paths
3. Add safe prompt-injection escaping when injecting recalled memory into prompts

Success criteria:
- semantic recall finds relevant historical notes across files in <300ms local
- deletions in markdown remove corresponding vector records

### Phase 2 (4-7 days): `cortana-external` hybrid retrieval

1. Add `cortana_memories` metadata table + migration
2. Add embedding/index service with provider abstraction
3. Add `/api/memory/search` + Mission Control memory panel
4. Add access-count updates and recency-aware scoring

Success criteria:
- dashboard shows meaningful semantic memory matches tied to source records
- no regressions to existing SQL-first workflows

### Phase 3 (1-2 weeks): cognition extraction + governance

1. Implement extraction worker from events/feedback/logs
2. Add dedupe + supersession chain
3. Add approval-gate checkpoints for sensitive actions
4. Add observability counters (extract success, dedupe rate, stale memory conflicts)

Success criteria:
- durable facts/preferences are auto-promoted with low noise
- corrected preferences supersede stale ones deterministically

### Phase 4 (optional): move from LanceDB to Qdrant if needed

Trigger conditions to migrate:
- multi-host retrieval needs
- >100k vectors + concurrent workloads
- need richer operational controls/backups around vector infra

Migration:
- re-embed from authoritative markdown + metadata
- keep ID determinism for idempotent upserts

---

## 7) Risks & Tradeoffs

### 1. Memory poisoning / instruction contamination

Risk: recalled memory text can carry malicious or stale instructions.
Mitigation:
- strict escaping + explicit “untrusted memory” prompt wrapper
- classifier for suspicious memories
- never execute tool calls from recalled memory text

### 2. Heuristic capture quality

Risk: regex capture misses nuanced facts and stores noise.
Mitigation:
- transition to extraction model + schema validation
- confidence thresholds + human review path for low-confidence entries

### 3. Backend portability and ops complexity

- LanceDB: simple local setup, but native binary portability caveats
- Qdrant: cleaner service boundary + robust ops, but more infra overhead

Tradeoff recommendation:
- LanceDB first for speed
- Qdrant later for scale and service isolation

### 4. Duplication between SQL and vector stores

Risk: drift/inconsistency if both treated as source of truth.
Mitigation:
- explicit source-of-truth policy:
  - markdown files + Postgres tables = authoritative
  - vector store = derived index only
- deterministic IDs + periodic reconciliation

### 5. Premature control-plane adoption

Risk: importing full cortex-plane architecture too early increases complexity.
Mitigation:
- adopt principles incrementally (memory tiers, extraction, approvals)
- avoid full platform rewrite until clear bottlenecks appear

---

## Final Recommendation

For your environment, the best move is **not** “replace everything with one repo’s architecture.” The winning strategy is:

1. Use `openclaw-memory-lancedb` patterns for immediate semantic recall gains.
2. Use `cortex-plane` memory architecture principles (tiering, sync, supersession, governance) as your long-term blueprint.
3. Keep PostgreSQL + markdown authoritative; treat vector DB as a derived acceleration layer.

That gives you fast wins now and a clean path toward a true cognition layer without destabilizing current operations.