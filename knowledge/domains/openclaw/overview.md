# OpenClaw Overview

OpenClaw is the runtime-facing compatibility layer around the `cortana` source repo.

## Current State

`/Users/hd/Developer/cortana` is the canonical source repo.
`/Users/hd/openclaw` is retained as a compatibility shim for older callers and runtime expectations.

That means OpenClaw is not a second source repo anymore. It is a deployment/runtime compatibility path.

## Deploy Model

The expected flow is:

1. author and merge changes in `cortana`
2. keep `main` clean and in sync
3. deploy runtime state from the source repo using the controlled sync scripts

Tracked config should come from `cortana`, while runtime-owned generated state should continue to live under `~/.openclaw/`.

## Documentation Rule

There are no active OpenClaw planning docs in `cortana` right now.
If new OpenClaw planning work starts again, place it under:

- `docs/source/planning/openclaw/prd/`
- `docs/source/planning/openclaw/techspec/`
- `docs/source/planning/openclaw/implementation/`

## Primary Source Docs

- [Runtime deploy model](../../../docs/source/architecture/runtime-deploy-model.md)
- [Root README](../../../README.md)
