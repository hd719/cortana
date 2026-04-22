# Runtime Deploy Model

`/Users/hd/Developer/cortana` is the source repo and active workspace. `/Users/hd/openclaw` is retained only as a compatibility shim path to the source repo.

## Roles

- Source repo: author code, docs, prompts, and tracked config here first.
- Compatibility shim: `/Users/hd/openclaw` points at the source repo for legacy callers that still reference the old path.
- Runtime state: `~/.openclaw/*` stays runtime-owned for generated state, but tracked config is deployed from the repo.

## Standard deploy

After source `main` is clean, pushed, and ready:

```bash
/Users/hd/Developer/cortana/tools/deploy/sync-runtime-from-cortana.sh
```

What it does:

1. Verifies the source repo is clean, on `main`, and exactly at `origin/main`.
2. Migrates or validates `/Users/hd/openclaw` as a compatibility shim to the source repo.
3. Syncs `config/cron/jobs.json` into `~/.openclaw/cron/jobs.json` while preserving runtime-only state fields.
4. Verifies the shim, runtime cron state, and `openclaw gateway status`.

`tools/repo/repo-auto-sync.sh` is allowed one narrow exception before that clean-main gate: promotable memory artifacts such as `memory/.dreams/*`, `memory/dreaming/*`, `DREAMS.md`, `identities/*/DREAMS.md`, and `memory/fitness/programs/json/current-tonal-catalog.json` are auto-promoted onto a feature branch with a draft PR instead of being discarded as volatile runtime dirt. Canonical runtime snapshots such as `memory/heartbeat-state.json` stay committed in the repo but are restored locally as volatile state.

## When to deploy

- After merging a PR to `main`.
- After any change that affects runtime behavior in `/Users/hd/Developer/cortana`.
- After recovering the source repo from a weird local state and re-establishing the intended `main` commit.

For the standard post-merge flow:

```bash
/Users/hd/Developer/cortana/tools/repo/post-merge-sync.sh
```

That runs safe local cleanup first, then the controlled runtime deploy.

## What gets updated

- The `/Users/hd/openclaw` compatibility shim target.
- Runtime cron config at `~/.openclaw/cron/jobs.json`, derived from repo config with volatile runtime fields preserved.

It does not do blind repo-to-repo copying or destructive resets.

## Rollback

Default rollback path:

1. Revert the bad change in `/Users/hd/Developer/cortana` on `main`.
2. Push the revert.
3. Re-run `sync-runtime-from-cortana.sh`.

Why this is the default:

- Source control stays authoritative.
- Runtime remains reproducible.
- The source repo stays authoritative; the deploy state file records the last deployed commit and any migrated legacy runtime checkout is backed up under `~/.openclaw/backups/`.

If the source worktree gets weird, restore from source control or a backup under `~/.openclaw/backups/`; do not rely on `/Users/hd/openclaw` as a separate checkout anymore.
