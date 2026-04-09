# Research Workspace

This directory is the exploration layer for `cortana`.

In the Karpathy-style workflow:
- `research/raw/` holds source material collected for investigation
- `research/derived/` holds LLM-generated outputs created from that source material
- `knowledge/` holds the compiled current-truth wiki after durable conclusions are promoted

Use this area when the work is still exploratory, comparative, or synthesis-heavy and should not go straight into canonical docs.

## Layout

- `raw/` - clipped articles, imported notes, source documents, image references, and rough inputs
- `derived/` - generated briefs, comparisons, slide decks, Q&A outputs, and temporary synthesis artifacts

## Promotion Rule

Use `research/` for exploration.

Promote to `knowledge/` when:
- the conclusion is durable
- it changes current truth
- it should become part of the compiled wiki

Promote to `docs/source/` when:
- the output becomes a durable source artifact such as a runbook, architecture note, or planning doc

If a research thread stops being useful, archive or delete it instead of letting `research/` become a dumping ground.
