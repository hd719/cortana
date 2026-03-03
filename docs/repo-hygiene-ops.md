# Repo Hygiene Ops (cortana + cortana-external)

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

## Post-merge local sync

```bash
/Users/hd/Developer/cortana/tools/repo/post-merge-sync.sh
```

## Drift watchdog (manual)

```bash
/Users/hd/Developer/cortana/tools/repo/drift-watchdog.sh
```

Exit codes:
- `0`: no drift/no dirt
- `1`: drift/dirty/missing repo detected

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
