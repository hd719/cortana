# Knowledge Layer

This directory is the compiled wiki layer for `cortana`.

In the Karpathy-style workflow:
- raw source material lives in `docs/source/`
- live doctrine and continuity still live at the repo root, `memory/`, and `identities/`
- `knowledge/` is where the LLM-maintained current-truth summaries should live

The goal is not to duplicate every raw doc.
The goal is to compile the important parts into a smaller set of canonical pages that are easier to browse, query, and maintain.

## Start Here

- [Systems index](./indexes/systems.md)
- [Cortana core overview](./domains/cortana-core/overview.md)
- [Memory system overview](./domains/memory-system/overview.md)
- [Covenant overview](./domains/covenant/overview.md)
- [Spartan overview](./domains/spartan/overview.md)
- [Trading overview](./domains/trading/overview.md)

## Working Rule

Use `knowledge/` for:
- current truth
- cross-document summaries
- stable domain overviews
- navigation pages and indexes

Use `docs/source/` for:
- PRDs
- tech specs
- implementation plans
- runbooks
- architecture notes
- doctrine source material

Use `docs/archive/` when a document is still worth keeping in git but no longer belongs in the active reading path.

## Current Structure

```text
knowledge/
├── README.md
├── INDEX.md
├── indexes/
└── domains/
```

`INDEX.md` is legacy.
`indexes/` and `domains/` are the active compiled-wiki entrypoints.
