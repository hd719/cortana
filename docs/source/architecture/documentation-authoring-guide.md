# Documentation Authoring Guide

This guide is for any human or LLM adding or updating docs in `cortana`.

It is intentionally model-agnostic.

## Core Principle

Do not treat every markdown file in this repo as the same kind of thing.

`cortana` has four different information layers:

1. Boot doctrine
2. Working memory
3. Agent namespace doctrine
4. Durable source docs and canonical knowledge

Only the last layer belongs under `docs/` and `knowledge/`.

## What Stays Outside `docs/`

### Root boot doctrine

These stay at repo root:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `IDENTITY.md`
- `MEMORY.md`
- `HEARTBEAT.md`

If behavior or identity changes at the command-deck level, update these files directly.

### Working memory

Use `memory/` for:

- daily notes
- session continuity
- transient investigations
- operational breadcrumbs

`memory/` is not a normal docs area.

### Agent namespace doctrine

Use `identities/<agent>/` for per-agent files like:

- `SOUL.md`
- `USER.md`
- `IDENTITY.md`
- `MEMORY.md`
- `HEARTBEAT.md`
- `TOOLS.md`

These are identity/runtime files, not general docs.

### Covenant role scaffolds

Use `covenant/` for Covenant-specific role instructions and knowledge contracts.

## The Two-Layer Documentation Model

### 1. Source docs

Source docs are the durable raw artifacts.

Examples:

- doctrine
- architecture notes
- runbooks
- research writeups
- prompts
- PRDs
- tech specs
- implementation plans
- roadmaps

These live under `docs/source/`.

### 2. Canonical knowledge

Canonical knowledge is the compiled "current truth" layer.

Examples:

- system overviews
- current-state summaries
- canonical domain pages
- index pages

These live under `knowledge/domains/` and `knowledge/indexes/`.

This sits alongside the older Covenant knowledge outputs in:

- `knowledge/research/`
- `knowledge/patterns/`
- `knowledge/topics/`
- `knowledge/predictions/`

## Placement Matrix

### `docs/source/doctrine/`

Use for long-lived operating doctrine and behavioral rules.

### `docs/source/architecture/`

Use for system design and internal mechanics.

### `docs/source/runbook/`

Use for operator playbooks, incident recovery, and maintenance procedures.

### `docs/source/research/`

Use for investigations, comparative analysis, or analytical writeups that are not canonical current truth.

### `docs/source/reference/`

Use for compact reference material.

### `docs/source/prompts/`

Use for reusable prompt artifacts that should be versioned.

### `docs/source/planning/`

Use for planning artifacts and roadmaps.

Current planning domains:

- `spartan/`
- `trading/`
- `openclaw/`

Within a planning domain, use typed subfolders when appropriate:

- `prd/`
- `techspec/`
- `implementation/`
- `roadmap/`
- `architecture/`
- `tickets/`

### `docs/source/planning/templates/`

Use for reusable planning templates.

Current shared templates:

- `prd-template.md`
- `techspec-template.md`
- `implementation-template.md`

## Knowledge Layer Rules

Use `knowledge/domains/` when you want a new reader or LLM to quickly understand:

- what this system is
- what exists right now
- where the source docs live
- what the canonical reading order is

Use `knowledge/indexes/` for discovery and navigation.

Do not put raw planning artifacts in `knowledge/`.

## When To Create A New Doc

Create a new doc when:

- the subject is durable
- the topic has a clear owner and purpose
- the content is large enough to deserve its own file
- you are creating a genuinely new artifact type

Update an existing doc when:

- the subject is the same
- the document purpose is unchanged
- you are revising current behavior rather than inventing a new parallel narrative

Do not create a new doc just because the old one is annoying.

## Naming Rules

- Use kebab-case file names.
- Name docs by subject, not by vague status words.
- Keep one subject per file.
- Use dates only when the document is inherently time-scoped.

## Link Rules

- Use relative markdown links for repo-local docs whenever possible.
- Prefer the new canonical path, not legacy pre-reorg paths.
- After moving docs, update inbound references in root docs, config, tests, and tools if those paths are used operationally.

## Planning Template Rules

When creating a new planning doc:

1. start from the matching file in `docs/source/planning/templates/`
2. place the new doc in the correct planning domain
3. replace placeholder text with repo-specific details
4. link the PRD, Tech Spec, and Implementation Plan together once they exist

Use:

- `docs/source/planning/templates/prd-template.md` for product requirements
- `docs/source/planning/templates/techspec-template.md` for technical design
- `docs/source/planning/templates/implementation-template.md` for execution planning

If you create a new planning family, keep the same three-document shape unless there is a clear reason not to.

## Recommended Authoring Flow

1. Decide whether the change belongs in root doctrine, memory, identities, docs, or knowledge.
2. If it is a durable source doc, place it in the correct `docs/source/` area.
3. If it changes current truth, update the matching `knowledge/domains/...` page too.
4. Update relevant README/index files if discoverability changes.
5. Verify markdown links before finishing.

## Anti-Patterns

Avoid these:

- using `docs/` as a dumping ground
- copying planning docs into multiple locations
- putting session memory into `docs/`
- putting identity doctrine into `knowledge/`
- creating canonical summary pages inside raw planning folders
- leaving config or tests pointed at deleted doc paths
