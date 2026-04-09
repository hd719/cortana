# Memory System Overview

The memory system in `cortana` spans multiple layers and is intentionally not a single file or database table.

## Layers

- root `MEMORY.md`: curated long-term truth, preferences, durable rules
- `memory/`: daily notes, transient continuity, runtime-owned artifacts
- structured memory engine: ingest, semantic/procedural/episodic storage, provenance, and compaction
- `knowledge/`: compiled wiki pages that summarize current truth for browsing and question-answering

## Engine Design

The current memory engine is built around three tiers:

- episodic memory for what happened
- semantic memory for facts, preferences, and stable rules
- procedural memory for workflows and learned corrections

Each memory item should carry provenance, trust, and lifecycle metadata so the system can distinguish durable truth from one-off events.

## Ingestion Model

Current ingestion is designed to promote memory from:

- recent `memory/*.md` notes
- feedback/correction records
- durable extracted lessons

The ingest pipeline logs run status, provenance, and memory health signals so the system can track whether memory maintenance is actually working.

## Retrieval Policy

Retrieval is tier-aware rather than purely vector-based.

The intended balance is:

- relevance
- recency
- trust

Semantic and procedural items should bias more heavily toward trust than raw episodic notes.

## Compaction Policy

- low-salience episodic items can be archived over time
- semantic facts should be superseded, not overwritten blindly
- procedural workflows should be deprecated only when they repeatedly fail or are explicitly replaced

## Primary Source Docs

- [Memory engine design](../../../docs/source/architecture/memory-engine-design.md)
- [Memory compression](../../../docs/source/architecture/memory-compression.md)
- [Local embeddings](../../../docs/source/architecture/local-embeddings.md)
