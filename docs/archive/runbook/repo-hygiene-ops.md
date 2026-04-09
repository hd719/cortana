# Repo Hygiene Ops (cortana + openclaw runtime)

## Pre-flight branch hygiene (before coding)

```bash
/Users/hd/Developer/cortana/tools/repo/hygiene-check.sh
```

Optional remediation preview (dry-run):

```bash
/Users/hd/Developer/cortana/tools/repo/hygiene-check.sh --fix --confirm-destructive
```

Execute remediation (destructive):

```bash
/Users/hd/Developer/cortana/tools/repo/hygiene-check.sh --fix --confirm-destructive --execute
```

## Post-merge local cleanup

```bash
/Users/hd/Developer/cortana/tools/repo/post-pr-cleanup.sh
```

This uses the same safe hygiene engine as routine repo overwatch:
- fast-forward local `main` when safe
- delete merged local branches only
- remove obvious `/tmp` worktrees for merged branches
- suppress volatile runtime-state false dirt
- verify clean and only report actionable/risky leftovers

## Controlled runtime deploy

Deploy source `main` into the runtime checkout:

```bash
/Users/hd/Developer/cortana/tools/deploy/sync-runtime-from-cortana.sh
```

This is git-aware and non-destructive:
- source repo must be clean, on `main`, and synced with `origin/main`
- runtime repo must be clean, on `main`, and fast-forwardable
- runtime moves by git fast-forward, not blind file copying
- cron state is deployed repo -> runtime with volatile fields preserved

Standard merged-and-deploy flow:

```bash
/Users/hd/Developer/cortana/tools/repo/post-merge-sync.sh
```

This runs `post-pr-cleanup.sh` first, then the controlled runtime deploy.

## Drift watchdog (manual)

```bash
/Users/hd/Developer/cortana/tools/repo/drift-watchdog.sh
```

Exit codes:
- `0`: no drift/no dirt
- `1`: drift/dirty/missing repo detected

## Routing drift checker

```bash
npx tsx /Users/hd/Developer/cortana/tools/monitoring/ops-routing-drift-check.ts
```

This enforces the stable owner-lane contract:
- inbox/email ops + maintenance alerts route through **Monitor**
- healthy watcher paths stay quiet with `NO_REPLY`
- stable routing/preferences updates belong in `MEMORY.md`, `HEARTBEAT.md`, `docs/source/doctrine/agent-routing.md`, `docs/source/doctrine/operating-rules.md`, `README.md`, and `config/cron/jobs.json` together

## PR completion protocol (standard)

Checklist to include in completion message:

- [ ] PR link(s)
- [ ] Tests status (pass/fail + what ran)
- [ ] Merge/restart steps completed (if applicable)
- [ ] Local sync status for both repos (`post-merge-sync.sh` output)

## Subagent retry policy (empty/aborted runs)

If a subagent run returns empty output or aborts:

1. Retry **once immediately** with a concise, scoped prompt.
2. If second run is still empty/aborted, notify immediately with probable cause (timeout/tool failure/prompt mismatch) and next best manual action.

## Subagent reliability controls (Task 2)

- A 15-minute reliability reaper job runs `check-subagents-with-retry.sh`.
- Policy:
  1. Try watchdog once.
  2. Retry once on failure.
  3. If second attempt fails, emit `fallback_manual_required=true` for operator intervention.
- This improves resilience against transient aborted/empty subagent runs.

## Deploy-time drift warning

Run before deploy/restart to warn (non-blocking) if source and runtime differ:

```bash
/Users/hd/Developer/cortana/tools/release/deploy-drift-warning.sh
```

## Session lifecycle policy by type

Policy file: `config/session-lifecycle-policy.json`

- `chat`: keep more (default 40)
- `subagent`: keep less (default 20)
- `cron`: keep very little (default 10)

Check policy drift and emit alert text only on breach:

```bash
npx --yes tsx /Users/hd/Developer/cortana/tools/session/session-lifecycle-policy.ts
```
