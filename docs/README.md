# Cortana Docs

This directory holds the raw source-document layer for the `cortana` repo.
It documents the command brain, not the runtime body. Runtime and trading surfaces live in `cortana-external`.

It does **not** replace:
- root boot doctrine like `SOUL.md` and `MEMORY.md`
- live continuity in `memory/`
- isolated OpenClaw runtime wiki content under `~/.openclaw/wiki/cortana`
- agent namespace files in `identities/`
- Covenant role scaffolds in `covenant/`

In the LLM wiki model:
- `research/` = exploration, collected inputs, and derived outputs
- `docs/source/` = raw source material and durable artifacts
- `knowledge/` = compiled current-truth wiki
- `docs/archive/` = historical overflow kept out of the active front door

OpenClaw also maintains an isolated `memory-wiki` vault for runtime-imported chats and compiled wiki pages. That vault powers Dreaming surfaces like `Imported Insights` and `Memory Palace`, but it is runtime state, not source-of-truth documentation for this repo.

## Start Here

- [Repo split map](./source/architecture/repo-split-map.md)
- [Documentation authoring guide](./source/architecture/documentation-authoring-guide.md)
- [Research workspace](../research/README.md)
- [Canonical knowledge index](../knowledge/indexes/systems.md)

## Layout

- `source/doctrine/` - durable operating rules and behavior doctrine
- `source/architecture/` - system design, internal mechanics, and structural docs
- `source/runbook/` - operator playbooks and recovery procedures
- `source/planning/` - PRDs, tech specs, implementation plans, and roadmaps
- `source/planning/templates/` - shared planning templates for PRDs, tech specs, and implementation plans
- `archive/` - historical or low-signal docs kept for reference but not treated as current reading

Use `research/` when the material is still exploratory and should not yet become canonical or a durable source artifact.
Use `docs/source/` for durable source docs about the command brain.

## Most Important Source Docs

- [Operating rules](./source/doctrine/operating-rules.md)
- [Agent routing](./source/doctrine/agent-routing.md)
- [Heartbeat ops](./source/doctrine/heartbeat-ops.md)
- [Autonomy policy](./source/doctrine/autonomy-policy.md)
- [Task board](./source/doctrine/task-board.md)
- [Documentation authoring guide](./source/architecture/documentation-authoring-guide.md)
- [PRD template](./source/planning/templates/prd-template.md)
- [Tech spec template](./source/planning/templates/techspec-template.md)
- [Implementation plan template](./source/planning/templates/implementation-template.md)
- [Spartan planning index](./source/planning/spartan/README.md)
- [Memory engine design](./source/architecture/memory-engine-design.md)
- [Runtime deploy model](./source/architecture/runtime-deploy-model.md)
- [Archive guide](./archive/README.md)
