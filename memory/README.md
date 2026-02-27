# `memory/` Directory Index

This directory is the **operational memory workspace** for Cortana on this machine. It holds daily logs, archival history, research notes, upgrade plans, and supporting state for the memory system.

It is **human-readable first** and acts as a primary source of truth for many parts of the unified memory architecture (see `../docs/memory-architecture.md`).

---

## 1. Top-level layout

Current contents (by category):

- **Daily log files**
  - `YYYY-MM-DD.md` at the top level (e.g. `2026-02-26.md`).
  - Represents the *current* and most recent days that are still "active" before archival.

- **Archive**
  - `archive/YYYY/MM/YYYY-MM-DD.md`
  - Normalized structure for older daily logs.

- **Fitness**
  - `fitness/`
  - Whoop/Tonal and general fitness-related notes, summaries, and investigations.

- **Upgrades**
  - `upgrades/`
  - Notes and plans around self-improvement and architectural upgrades.

- **Mission plans**
  - `mission-plans/`
  - Multi-day or multi-epic planning documents and checklists.

- **Research**
  - `research/`
  - Deep-dives and architecture writeups (e.g. `research-openclaw-memory-cortex-plane.md`).

- **Playbooks**
  - `playbooks/`
  - Operational playbooks and runbooks for recurring situations.

- **Cron / health state snapshots**
  - Files like `heartbeat-state.json`, `cron-health-48h.json`, `cron-health-48h-errors.json`, `crons-summary.md`, `watchdog-lancedb-check.md`, `lancedb-fix.md`.
  - Used for debugging and monitoring the memory + cron ecosystem.

- **Special-purpose JSON state**
  - `calendar-reminders-sent.json`, `newsletter-alerted.json`, `circuit-breaker-state.json`, etc.
  - These are **operational state snapshots**, not long-term memory; treat them as ephemeral, machine-managed state.

- **Other focused notes**
  - e.g. `typing-indicator-investigation.md`, `subagent-routing-implementation.md`, `cron-optimization-feb26.md`, `feedback-recurrence-analysis.md`.

---

## 2. Daily logs and archive rules

### 2.1 Daily log naming

- Each day has a primary log file named:

  ```text
  memory/YYYY-MM-DD.md
  ```

- These files capture raw notes, events, tasks, and observations from that day.

### 2.2 Archive structure

- Older daily logs live under the archive tree:

  ```text
  memory/archive/YYYY/MM/YYYY-MM-DD.md
  ```

  Example:

  ```text
  memory/archive/2026/02/2026-02-08.md
  memory/archive/2026/02/2026-02-25.md
  ```

- The structure is intentionally consistent:
  - **Year** directory at the first level under `archive/`.
  - **Month** subdirectory (`01`-`12`).
  - Markdown file named with the full date.

### 2.3 Archival rules

1. **Active window**
   - Recent days (typically yesterday and today) may live as top-level `memory/YYYY-MM-DD.md`.
   - Anything older should be moved into `memory/archive/YYYY/MM/`.

2. **Move, dont copy**
   - When archiving, move the file (so there is exactly one canonical copy).

3. **Preserve links**
   - If external references point to a daily file, update links when archiving or use relative paths that remain valid under `archive/YYYY/MM/`.

4. **Normalization**
   - If you ever find stray `memory/YYYY-MM-DD.md` files for older dates, move them into the appropriate `archive/YYYY/MM/` folder to keep the structure consistent.

At the time of this doc, `archive/` already uses the normalized `YYYY/MM/YYYY-MM-DD.md` structure; there are no mixed patterns to clean up.

---

## 3. Subdirectories

### 3.1 `fitness/`

- Hosts fitness-related notes, analysis, and supporting docs used by the `fitness-coach` skill.
- Expect references to Whoop recovery, Tonal strength sessions, strain targets, etc.

### 3.2 `upgrades/`

- Holds proposals and notes for self-improvement and system upgrades.
- Often linked to rows in `cortana_upgrades` or discussed in `docs/`.

### 3.3 `mission-plans/`

- Multi-step plans for epics or projects.
- Think of these as higher-level playbooks or operations orders.

### 3.4 `research/`

- Deep research documents, including memory architecture analyses, indexing investigations, and control-plane concepts.
- Example: `research-openclaw-memory-cortex-plane.md` (foundation for the unified memory architecture).

### 3.5 `playbooks/`

- Human-readable runbooks for repeated workflows.
- Some may be candidates for promotion into `cortana_memory_procedural` as structured procedural memory.

### 3.6 Other supporting files

- State snapshots (`*.json`) and investigative notes (`*-investigation.md`) are used to debug and improve the memory system and cron behavior.

---

## 4. Interaction with LanceDB & Semantic Indexing

The `memory/` directory doesnt embed vectors itself, but it is a **primary source** for semantic indexing.

There are two main paths:

1. **Unified memory ingestion → Postgres → pgvector**

   - `tools/memory/ingest_unified_memory.py` (see `tools/memory/README.md`) periodically scans recent markdown files in `memory/` and other sources.
   - Extracted facts, events, and procedures are written into the `cortana_memory_*` tables:
     - `cortana_memory_semantic`
     - `cortana_memory_episodic`
     - `cortana_memory_procedural`
   - From there, embeddings are computed into `embedding` (OpenAI) and/or `embedding_local` (fastembed), and indexed via pgvector per `docs/vector-spine.md`.

2. **Semantic indexing for OpenClaw memory (LanceDB)**

   - The OpenClaw memory extension (LanceDB-based plugin) maintains a local LanceDB DB at `~/.openclaw/memory/main.sqlite`.
   - While its primary intake is conversational logs, **markdown content under `memory/` can be synchronized into that index** via higher-level ingestion scripts or manual promotion.
   - Files like `watchdog-lancedb-check.md` and `lancedb-fix.md` live in this directory precisely to track the health and repair of that LanceDB index.

**Key principle:**

> `memory/` is always the human-readable source. Any LanceDB or pgvector indexes are derived layers that can be fully rebuilt from these files + the Postgres tables when needed.

---

## 5. How to work with this directory

- When Hamel says "remember this" →
  - In the main session, append to `MEMORY.md` (for durable identity/preferences), and/or
  - Log the event in todays `memory/YYYY-MM-DD.md`.

- When doing deep analysis or architecture work →
  - Use `memory/research/` for multi-page deep dives.

- When planning longer efforts →
  - Use `memory/mission-plans/` or `memory/upgrades/`.

- When investigating memory issues →
  - Use supporting docs here (`*-investigation.md`, `*lancedb*.md`) instead of scattering notes elsewhere.

Keeping this directory well-structured and normalized makes it much easier to:

- Run ingestion and consolidation jobs safely.
- Rebuild vector indexes from scratch.
- Trace any piece of semantic or episodic memory back to the original markdown.

For a full cross-system view (markdown + Postgres + LanceDB + embeddings), see `../docs/memory-architecture.md`.