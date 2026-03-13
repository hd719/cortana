# Runtime Deploy Model

`/Users/hd/Developer/cortana` is the source repo. `/Users/hd/openclaw` is the controlled runtime and backup checkout.

## Roles

- Source repo: author code, docs, prompts, and tracked config here first.
- Runtime repo: a clean `main` checkout that only advances through the deploy flow.
- Runtime state: `~/.openclaw/*` stays runtime-owned for generated state, but tracked config is deployed from the repo.

## Standard deploy

After source `main` is clean, pushed, and ready:

```bash
/Users/hd/Developer/cortana/tools/deploy/sync-runtime-from-cortana.sh
```

What it does:

1. Verifies the source repo is clean, on `main`, and exactly at `origin/main`.
2. Verifies the runtime repo is clean, on `main`, and can fast-forward to the source commit.
3. Fast-forwards `/Users/hd/openclaw` to the source commit with git, not file mirroring.
4. Syncs `config/cron/jobs.json` into `~/.openclaw/cron/jobs.json` while preserving runtime-only state fields.
5. Verifies runtime git state and `openclaw gateway status`.

## When to deploy

- After merging a PR to `main`.
- After any change that affects runtime behavior in `/Users/hd/openclaw`.
- After recovering the source repo from a weird local state and re-establishing the intended `main` commit.

For the standard post-merge flow:

```bash
/Users/hd/Developer/cortana/tools/repo/post-merge-sync.sh
```

That runs safe local cleanup first, then the controlled runtime deploy.

## What gets updated

- The `/Users/hd/openclaw` git checkout.
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
- The runtime repo keeps the previously deployed commit until you explicitly deploy again.

If the source worktree gets weird, `/Users/hd/openclaw` remains the last known-good deployed checkout for comparison or recovery.
