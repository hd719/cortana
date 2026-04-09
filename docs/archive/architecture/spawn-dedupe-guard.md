# Spawn Dedupe Guard

## Goal
Prevent duplicate concurrent sub-agent launches for the same logical task, and reduce ghost runs.

## Implementation
File: `tools/covenant/spawn_guard.ts`

### Key computation
Dedupe key format:

`task:<task_id|none>|label:<normalized_label>`

Normalization:
- lower-case
- replace non-alphanumeric chars with `-`
- collapse repeated dashes
- trim leading/trailing dashes

Example:
- label: `Huragok migration hygiene`
- task_id: `4242`
- key: `task:4242|label:huragok-migration-hygiene`

### Behavior
- `claim`: before spawn, attempts to acquire the dedupe key.
  - If no active run: returns `claimed` and stores run metadata.
  - If active run exists for same key: returns `deduped` with existing run info.
- `release`: marks the run completed/failed/etc.
  - For terminal states (`completed`/`done`/`success`), mandatory done-gates run first:
    1) build passes
    2) targeted tests pass
    3) local `main` is clean vs `origin/main`
  - If any gate fails, release is blocked with `action: "blocked"` and failure details.
- Active entries use TTL (default 3600s) to avoid stale locks forever.

### Decision logging
- Attempts DB event bus publish (`cortana_event_bus_publish`) as `agent_spawn_dedupe`.
- If DB path is unavailable, falls back to JSONL at:
  - `reports/spawn_guard.decisions.jsonl`

## CLI usage
### Claim
```bash
npx tsx tools/covenant/spawn_guard.ts claim \
  --label "Huragok migration hygiene" \
  --task-id 4242 \
  --run-id run-abc
```

### Release
```bash
# DONE_GATES_TEST_CMD is required unless you pass --test-cmd
DONE_GATES_TEST_CMD="npx vitest run tests/covenant/spawn-guard.test.ts" \
npx tsx tools/covenant/spawn_guard.ts release \
  --label "Huragok migration hygiene" \
  --task-id 4242 \
  --run-id run-abc
```

Optional gate overrides:
- `--build-cmd "..."`
- `--test-cmd "..."`
- env fallbacks: `DONE_GATES_BUILD_CMD`, `DONE_GATES_TEST_CMD`

If blocked, CLI exits non-zero and returns JSON with failing gates.

### Demo (simulated duplicate prevention)
```bash
npx tsx tools/covenant/spawn_guard.ts demo
```

## CI wiring for release safety
- `.github/workflows/ci.yml` runs `npm run build` + tests on PRs/pushes to `main`.
- `.github/workflows/post-merge-smoke.yml` runs `npm run smoke:post-merge` after merges to `main`.
- On smoke failure, CI prints an automatic rollback hint (`git revert $GITHUB_SHA` + push instructions).
