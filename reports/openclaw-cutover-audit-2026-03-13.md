# OpenClaw Retirement Audit - 2026-03-13

## Scope

Audit target:
- all `/Users/hd/openclaw`
- all `~/openclaw`

Method:
- `rg -n --hidden --glob '!.git' -e '/Users/hd/openclaw' -e '~/openclaw' .`
- review of executable files, config, and docs containing live path assumptions

Current model confirmed during audit:
- source repo: `/Users/hd/Developer/cortana`
- controlled runtime/deploy checkout: `/Users/hd/openclaw`
- external apps/services: `/Users/hd/Developer/cortana-external`

## Classification

### 1. INTENTIONAL runtime/deploy reference

These references are still correct because they describe the deployed runtime checkout, agent workspaces, launchd jobs, or cron payloads that execute against the live runtime.

Files and families:
- `config/openclaw.json`
- `config/agent-profiles.json`
- `config/launchd/*.plist`
- `docs/agent-routing.md`
- `docs/runtime-deploy-model.md`
- `tools/deploy/sync-runtime-from-cortana.sh`
- `tools/monitoring/runtime-repo-drift-monitor.ts`
- `tools/repo/drift-watchdog.sh`
- runtime-facing prompts in `config/cron/jobs.json` that intentionally invoke deployed scripts under `/Users/hd/openclaw`

Why these stay:
- OpenClaw agents are still configured to boot from `/Users/hd/openclaw`
- launchd and cron payloads execute against the deployed runtime tree, not the source checkout
- drift detection and deploy tooling need both source and runtime paths simultaneously

### 2. STALE source/canonical reference

These were assuming `~/openclaw` was the authoring repo or local source root. They are safe to move to source-owned or repo-relative paths.

Updated in this patch:
- `README.md`
- `HEARTBEAT.md`
- `TOOLS.md`
- `tools/market-intel/README.md`
- `tools/mission-control/README.md`
- `tools/morning-brief/README.md`
- `tools/briefing/daily-command-brief.ts`
- `tools/briefing/run-daily-command-brief.sh`
- `tools/monitoring/update-self-model.ts`
- `tools/mission-control/deploy.ts`

Change pattern:
- docs now distinguish source repo from deployed runtime
- examples prefer source-owned or repo-relative paths
- selected code paths now resolve repo-local scripts instead of hardcoding `/Users/hd/openclaw`

### 3. NEEDS SHIM/CONFIG indirection

These still embed runtime paths, but changing them blindly would risk behavioral drift. They need an explicit env/config contract before `~/openclaw` can be retired.

High-priority blockers:
- `tools/task-board/auto-executor.ts`
  - embeds a long shell script with multiple `/Users/hd/openclaw/...` tool paths
  - should move to repo-root/runtime-root environment variables or a standalone script with clear inputs
- `tools/guardrails/provider-health.ts`
  - mixes repo-tracked config with mutable state under `/Users/hd/openclaw`
  - needs a decision on whether circuit-breaker state belongs in runtime state under `~/.openclaw` or in a configurable repo root
- `tools/alerting/cost-breaker.ts`
  - still shells out to repo-local skills and the telegram delivery guard through `/Users/hd/openclaw`
  - likely fixable, but should be moved under a single repo-root resolver rather than piecemeal edits
- `tools/memory/decay-scorer.ts`
  - points at `/Users/hd/openclaw/config/openmemory.json` and `/Users/hd/openclaw/.memory/lancedb`
  - needs explicit data-root configuration, not a hardcoded source/runtime guess
- `tools/openclaw/upstream-reliability-tracker.ts`
  - assumes repo root is `/Users/hd/openclaw`
  - low-risk to refactor later, but not required for this safe patch set

`config/cron/jobs.json` also needs a second pass:
- some payload strings intentionally reference runtime paths and should stay until runtime cutover
- some payload strings still treat `~/openclaw` as the canonical repo root for reads/writes
- because those strings are executable behavior, this file should be migrated job-by-job with runtime validation, not by bulk replace

### 4. HISTORICAL/DOC ONLY

These references are historical evidence, generated artifacts, or past audits. They should not block source cutover by themselves.

Examples:
- `reports/system-audit-2026-03-01.md`
- `reports/deep-audit-2026-03-01.md`
- `tools/cron-verification-report.md`
- generated/local result artifacts such as `.vitest-results.json`
- archival references inside `memory/` and other historical notes

## Safe patch set applied

Code:
- repo-relative resolution for daily command brief helper scripts
- repo-relative resolution for `skills/telegram-usage/handler.ts`
- repo-relative mission-control deploy log path

Docs:
- clarified source-vs-runtime ownership in top-level docs
- corrected stale source-root examples that still pointed at `~/openclaw`
- preserved explicit runtime-path docs where those paths are still operationally correct

## Blockers To A Real PR

- `config/cron/jobs.json` still contains mixed runtime-intent and canonical-source assumptions; it needs per-job migration with runtime testing
- several executable files still hardcode `/Users/hd/openclaw` and need a shared repo-root/runtime-root abstraction
- runtime agent workspace config still points at `/Users/hd/openclaw`; source cutover is not real until workspace ownership is redesigned or shims are installed
- launchd jobs and runtime verification docs still assume `~/openclaw` exists as a deploy checkout

## Suggested Next Cutover Steps

1. Introduce one shared path contract:
   - `CORTANA_SOURCE_REPO`
   - `CORTANA_RUNTIME_REPO`
   - optional `CORTANA_RUNTIME_STATE_HOME`

2. Refactor executable code first, before cron prompts:
   - `tools/task-board/auto-executor.ts`
   - `tools/guardrails/provider-health.ts`
   - `tools/alerting/cost-breaker.ts`
   - `tools/memory/decay-scorer.ts`
   - `tools/openclaw/upstream-reliability-tracker.ts`

3. Audit `config/cron/jobs.json` job-by-job:
   - keep runtime-only invocations explicit
   - change stale canonical reads/writes to source-owned or env-driven paths
   - validate each changed job against the deployed runtime

4. Add a compatibility shim only if needed:
   - if runtime retirement must be staged, use a narrow shim from `~/openclaw` to the new deploy/runtime location
   - do not remove `~/openclaw` until agent workspace config, launchd jobs, and cron payloads are all migrated
