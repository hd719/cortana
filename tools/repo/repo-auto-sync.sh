#!/usr/bin/env bash
set -euo pipefail

REPOS=("/Users/hd/Developer/cortana" "/Users/hd/Developer/cortana-external")

fail() {
  local repo="$1"
  local step="$2"
  local detail="$3"
  printf 'FAIL repo=%s step=%s detail=%s\n' "$repo" "$step" "$detail" >&2
  return 1
}

ensure_clean_preflight() {
  local repo="$1"

  local status
  status="$(git -C "$repo" status --porcelain --untracked-files=all)"
  if [[ -n "$status" ]]; then
    fail "$repo" "preflight-clean" "working tree is dirty/untracked"
  fi

  local stash_count
  stash_count="$(git -C "$repo" stash list | wc -l | tr -d '[:space:]')"
  if [[ "$stash_count" != "0" ]]; then
    fail "$repo" "preflight-stash" "stash entries present ($stash_count)"
  fi
}

cleanup_local_merged_branches() {
  local repo="$1"

  git -C "$repo" for-each-ref --format='%(refname:short)' refs/heads --merged origin/main \
    | sed -E 's/^[*+[:space:]]+//' \
    | while IFS= read -r b; do
        b="$(printf '%s' "$b" | xargs)"
        if [[ -z "$b" || "$b" == "main" ]]; then
          continue
        fi
        if git -C "$repo" check-ref-format --branch "$b" >/dev/null 2>&1; then
          git -C "$repo" branch -d -- "$b" || true
        fi
      done
}

sync_repo() {
  local repo="$1"

  [[ -d "$repo/.git" ]] || fail "$repo" "preflight-repo" "missing git repo"

  ensure_clean_preflight "$repo"

  git -C "$repo" fetch --all --prune || fail "$repo" "fetch" "git fetch --all --prune failed"
  git -C "$repo" checkout main || fail "$repo" "checkout" "git checkout main failed"
  git -C "$repo" pull --ff-only origin main || fail "$repo" "pull" "git pull --ff-only origin main failed"

  cleanup_local_merged_branches "$repo" || fail "$repo" "branch-cleanup" "local merged branch cleanup failed"
}

for repo in "${REPOS[@]}"; do
  sync_repo "$repo"
done

printf 'Repo auto-sync hygiene complete for %s repos.\n' "${#REPOS[@]}"
