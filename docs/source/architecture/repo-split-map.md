# Repo Split Map

Use this page when you need the fastest answer to "which repo owns this?"

## The Split

- `cortana` is the command brain: doctrine, routing, memory, cron prompts, and compiled knowledge.
- `cortana-external` is the runtime body: Mission Control, external service code, trading/backtester runtime, and other operator-facing runtime surfaces.

## Read First

1. [Cortana Core Current State](../../../knowledge/domains/cortana-core/current-state.md)
2. [Runtime Deploy Model](./runtime-deploy-model.md)
3. [Documentation Authoring Guide](./documentation-authoring-guide.md)

## Simple Examples

- Editing `SOUL.md`, routing rules, or cron prompts belongs in `cortana`.
- Editing a health endpoint, trading service, or Mission Control UI belongs in `cortana-external`.
- If a change crosses both repos, update the source docs in `cortana` and the runtime implementation in `cortana-external` together.

