# OpenClaw Retirement Audit - 2026-03-13

## Scope

Audit target:
- all `/Users/hd/openclaw`
- all `~/openclaw`

Method:
- `rg -n --hidden --glob '!.git' -e '/Users/hd/openclaw' -e '~/openclaw' .`
- review of executable files, config, cron payloads, launchd config, and operator docs

Current model after this cutover pass:
- canonical source repo + primary workspace: `/Users/hd/Developer/cortana`
- compatibility shim path only: `/Users/hd/openclaw`
- runtime-owned mutable state: `~/.openclaw/*`
- external apps/services: `/Users/hd/Developer/cortana-external`

## What Actually Changed

### 1. Workspace ownership moved to source

Updated:
- `config/openclaw.json`
- `config/agent-profiles.json`

Result:
- main, huragok, researcher, oracle, monitor, and cortana-acp now point at `/Users/hd/Developer/cortana`
- hook loading now resolves from `/Users/hd/Developer/cortana/hooks`
- `~/openclaw` is no longer the configured primary workspace for agents

### 2. Runtime/deploy model changed from separate checkout to shim

Updated:
- `tools/deploy/sync-runtime-from-cortana.sh`
- `tools/openclaw/post-update.ts`
- `tools/openclaw/install-compat-shim.sh` (new)
- `tools/monitoring/runtime-repo-drift-monitor.ts`

Result:
- deploy flow now treats `/Users/hd/openclaw` as a compatibility shim path, not a separate git checkout
- existing clean legacy runtime checkout can be moved into `~/.openclaw/backups/` and replaced with a symlink to the source repo
- post-update now reasserts the shim and syncs cron state
- drift monitor now understands the shimmed runtime path and does not falsely page on source==runtime realpath

### 3. High-priority executable files cut over to shared path contracts

Updated:
- `tools/task-board/auto-executor.ts`
- `tools/task-board/auto-executor.sh` (new)
- `tools/guardrails/provider-health.ts`
- `tools/alerting/cost-breaker.ts`
- `tools/memory/decay-scorer.ts`
- `tools/openclaw/upstream-reliability-tracker.ts`
- `tools/lib/paths.ts`

Result:
- task-board auto-executor now runs from a real shell script with explicit `SOURCE_REPO` / `EXTERNAL_REPO`
- provider-health state moved toward runtime-owned `~/.openclaw/state/` with legacy fallback for old state files
- cost-breaker now resolves telegram usage + delivery guard from the source repo
- decay-scorer now resolves openmemory config + LanceDB path via runtime state / repo / legacy fallback instead of hardcoding `/Users/hd/openclaw`
- upstream reliability tracker now uses repo-relative source paths

### 4. Cron payloads no longer treat `~/openclaw` as canonical source

Updated:
- `config/cron/jobs.json`

Result:
- source-owned script/prompt references now point to `/Users/hd/Developer/cortana`
- mutable dedupe/state files moved to `~/.openclaw/state/*`
- the only intentional remaining `/Users/hd/openclaw` reference in cron payloads is the runtime drift monitor, and that prompt now explicitly documents it as a compatibility shim path

### 5. Launchd/operator docs no longer describe `~/openclaw` as the real repo

Updated:
- `config/launchd/*.plist`
- `README.md`
- `TOOLS.md`
- `docs/runtime-deploy-model.md`
- `docs/agent-routing.md`

Result:
- launchd plists now point at `/Users/hd/Developer/cortana`
- deploy/operator docs describe `/Users/hd/openclaw` as shim-only
- verification examples now use the source repo as the tracked config root

## Remaining Blockers / Risks

### 1. Legacy launchd entries still reference missing scripts

Still missing in this repo:
- `tools/memory/extract_facts.py`
- `tools/oracle/precompute.py`
- `tools/hygiene/sweep.py`
- `tools/memory/promote_insights.py`

Impact:
- path retirement is fixed, but those specific launchd jobs are still not runnable until the missing scripts are restored or the plists are removed

### 2. Some historical/docs/archive references still mention `~/openclaw`

Examples:
- old reports
- archived memory notes
- historical design docs outside the operational hot path

Impact:
- they do not drive runtime behavior
- they were intentionally not mass-rewritten in this pass

### 3. Compatibility shim still exists by design

Intentional leftover:
- `/Users/hd/openclaw` still appears in deploy/monitoring code and one cron payload because it is now the compatibility alias

Impact:
- canonical operation no longer depends on it as the primary workspace
- true deletion of the alias itself should wait until all external callers outside this repo are confirmed migrated

## Validation Performed

- updated path search across the high-priority files and cron config
- added/updated tests for:
  - deploy shim migration
  - runtime drift monitor shim awareness
  - auto-executor wrapper behavior
  - daily-upgrade cron prompt contract

## Summary

This branch is no longer an audit-only safe patch.

It converts the repo/workspace model so `/Users/hd/Developer/cortana` is the primary workspace, moves runtime state toward `~/.openclaw`, replaces the separate `~/openclaw` deploy checkout with a managed compatibility shim, and updates the live cron/config/runtime assumptions accordingly.

What still remains is cleanup of dead launchd jobs and any external callers outside this repo that still assume `/Users/hd/openclaw` is a real standalone checkout.
