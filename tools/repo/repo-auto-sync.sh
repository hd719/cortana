#!/usr/bin/env bash
set -euo pipefail

REPOS=("/Users/hd/Developer/cortana" "/Users/hd/Developer/cortana-external")
PROTECTED_BRANCHES=("main" "master" "dev" "develop")
VOLATILE_STATE_FILES=("memory/newsletter-alerted.json" "memory/x-trending-seen.json")

fail() {
  local repo="$1"
  local step="$2"
  local detail="$3"
  printf 'FAIL repo=%s step=%s detail=%s\n' "$repo" "$step" "$detail" >&2
  return 1
}

is_protected_branch() {
  local branch="$1"
  local protected

  for protected in "${PROTECTED_BRANCHES[@]}"; do
    if [[ "$branch" == "$protected" ]]; then
      return 0
    fi
  done

  return 1
}

sanitize_branch_token() {
  local raw="$1"

  printf '%s' "$raw" \
    | sed -E 's/^[*+[:space:]]+//' \
    | xargs
}

is_temp_worktree_path() {
  local path="$1"
  [[ "$path" == /tmp/* || "$path" == /private/tmp/* ]]
}

list_worktrees_for_branch() {
  local repo="$1"
  local branch="$2"
  local target_ref="refs/heads/$branch"
  local current_worktree=""
  local current_branch=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == worktree\ * ]]; then
      current_worktree="${line#worktree }"
      current_branch=""
      continue
    fi

    if [[ "$line" == branch\ * ]]; then
      current_branch="${line#branch }"
      continue
    fi

    if [[ -z "$line" ]]; then
      if [[ "$current_branch" == "$target_ref" && -n "$current_worktree" ]]; then
        printf '%s\n' "$current_worktree"
      fi
      current_worktree=""
      current_branch=""
    fi
  done < <(git -C "$repo" worktree list --porcelain; printf '\n')
}

auto_stash_dirty_worktree() {
  local repo="$1"
  local branch="$2"
  local worktree_path="$3"

  local status
  status="$(git -C "$worktree_path" status --porcelain --untracked-files=all)"
  if [[ -z "$status" ]]; then
    printf 'INFO repo=%s step=branch-cleanup detail=temp-worktree-clean branch=%q worktree=%q\n' "$repo" "$branch" "$worktree_path" >&2
    return 0
  fi

  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local stash_message
  stash_message="repo-auto-sync auto-stash branch=$branch ts=$ts"

  if git -C "$worktree_path" stash push --include-untracked -m "$stash_message" >/dev/null 2>&1; then
    printf 'INFO repo=%s step=branch-cleanup detail=temp-worktree-stashed branch=%q worktree=%q stash_message=%q\n' "$repo" "$branch" "$worktree_path" "$stash_message" >&2
    return 0
  fi

  printf 'WARN repo=%s step=branch-cleanup detail=temp-worktree-stash-failed branch=%q worktree=%q\n' "$repo" "$branch" "$worktree_path" >&2
  return 1
}

remove_temp_worktree_for_branch() {
  local repo="$1"
  local branch="$2"
  local worktree_path="$3"

  if ! is_temp_worktree_path "$worktree_path"; then
    printf 'WARN repo=%s step=branch-cleanup detail=non-temp-worktree-skip branch=%q worktree=%q\n' "$repo" "$branch" "$worktree_path" >&2
    return 1
  fi

  if auto_stash_dirty_worktree "$repo" "$branch" "$worktree_path"; then
    if git -C "$repo" worktree remove -- "$worktree_path" >/dev/null 2>&1; then
      printf 'INFO repo=%s step=branch-cleanup detail=temp-worktree-removed branch=%q worktree=%q\n' "$repo" "$branch" "$worktree_path" >&2
      return 0
    fi
    printf 'WARN repo=%s step=branch-cleanup detail=temp-worktree-remove-failed branch=%q worktree=%q\n' "$repo" "$branch" "$worktree_path" >&2
    return 1
  fi

  return 1
}

resolve_branch_worktree_conflicts() {
  local repo="$1"
  local branch="$2"
  local blocked=0
  local worktree_path=""

  while IFS= read -r worktree_path; do
    [[ -n "$worktree_path" ]] || continue

    if [[ "$worktree_path" == "$repo" ]]; then
      printf 'WARN repo=%s step=branch-cleanup detail=branch-checked-out-in-primary-worktree branch=%q worktree=%q\n' "$repo" "$branch" "$worktree_path" >&2
      blocked=1
      continue
    fi

    if ! remove_temp_worktree_for_branch "$repo" "$branch" "$worktree_path"; then
      blocked=1
    fi
  done < <(list_worktrees_for_branch "$repo" "$branch")

  if (( blocked != 0 )); then
    return 1
  fi

  return 0
}

ensure_clean_preflight() {
  local repo="$1"

  if [[ "$repo" == "/Users/hd/Developer/cortana" ]]; then
    git -C "$repo" restore --worktree -- "${VOLATILE_STATE_FILES[@]}" >/dev/null 2>&1 || true
  fi

  local status
  status="$(git -C "$repo" status --porcelain --untracked-files=all)"
  if [[ -z "$status" ]]; then
    return 0
  fi

  local tracked_dirty=0
  local untracked_only=0

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue

    local xy path
    xy="${line:0:2}"
    path="${line:3}"

    printf 'WARN repo=%s step=preflight-clean detail=status-entry kind=%q entry=%q\n' "$repo" "$xy" "$line" >&2

    if [[ "$xy" == "??" ]]; then
      untracked_only=1
      continue
    fi

    tracked_dirty=1
  done <<< "$status"

  if [[ "$tracked_dirty" -eq 1 ]]; then
    printf 'WARN repo=%s step=preflight-clean detail=tracked-changes-present-skip\n' "$repo" >&2
    return 2
  fi

  if [[ "$untracked_only" -eq 1 ]]; then
    printf 'WARN repo=%s step=preflight-clean detail=untracked-only-continue\n' "$repo" >&2
    return 0
  fi

  return 0
}

snapshot_existing_stash_metadata() {
  local repo="$1"
  local stash_list="$2"

  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local snapshot_log
  snapshot_log="${REPO_AUTO_SYNC_STASH_SNAPSHOT_LOG:-/tmp/repo-auto-sync-stash-snapshots.log}"

  {
    printf 'ts=%s repo=%q step=preflight-stash detail=stash-snapshot-begin\n' "$ts" "$repo"
    while IFS= read -r entry; do
      [[ -z "$entry" ]] && continue
      printf 'ts=%s repo=%q step=preflight-stash stash_entry=%q\n' "$ts" "$repo" "$entry"
    done <<< "$stash_list"
    printf 'ts=%s repo=%q step=preflight-stash detail=stash-snapshot-end\n' "$ts" "$repo"
  } >> "$snapshot_log" 2>/dev/null || {
    printf 'WARN repo=%s step=preflight-stash detail=stash-snapshot-write-failed path=%q\n' "$repo" "$snapshot_log" >&2
    return 1
  }

  printf 'WARN repo=%s step=preflight-stash detail=stash-snapshot-written path=%q\n' "$repo" "$snapshot_log" >&2
  return 0
}

ensure_no_stash_preflight() {
  local repo="$1"

  local stash_list
  stash_list="$(git -C "$repo" stash list)"
  if [[ -n "$stash_list" ]]; then
    printf 'WARN repo=%s step=preflight-stash detail=stash-present-continue\n' "$repo" >&2
    while IFS= read -r entry; do
      [[ -z "$entry" ]] && continue
      printf 'WARN repo=%s step=preflight-stash detail=stash-entry entry=%q\n' "$repo" "$entry" >&2
    done <<< "$stash_list"

    snapshot_existing_stash_metadata "$repo" "$stash_list" || true
  fi

  return 0
}

cleanup_local_merged_branches() {
  local repo="$1"

  git -C "$repo" for-each-ref --format='%(refname:short)' refs/heads --merged origin/main \
    | while IFS= read -r raw_branch; do
        local b
        b="$(sanitize_branch_token "$raw_branch")"

        if [[ -z "$b" ]]; then
          continue
        fi

        if is_protected_branch "$b"; then
          continue
        fi

        if ! git -C "$repo" check-ref-format --branch "$b" >/dev/null 2>&1; then
          printf 'WARN repo=%s step=branch-cleanup detail=invalid-branch-token branch=%q\n' "$repo" "$b" >&2
          continue
        fi

        if ! git -C "$repo" show-ref --verify --quiet "refs/heads/$b"; then
          printf 'INFO repo=%s step=branch-cleanup detail=already-missing branch=%q\n' "$repo" "$b" >&2
          continue
        fi

        if ! resolve_branch_worktree_conflicts "$repo" "$b"; then
          printf 'INFO repo=%s step=branch-cleanup detail=delete-skipped-worktree-blocked branch=%q\n' "$repo" "$b" >&2
          continue
        fi

        git -C "$repo" branch -d -- "$b" >/dev/null 2>&1 || \
          printf 'INFO repo=%s step=branch-cleanup detail=delete-skipped branch=%q\n' "$repo" "$b" >&2
      done
}

sync_repo() {
  local repo="$1"

  [[ -d "$repo/.git" ]] || fail "$repo" "preflight-repo" "missing git repo"

  local preflight_rc=0
  ensure_clean_preflight "$repo" || preflight_rc=$?
  if [[ "$preflight_rc" -ne 0 ]]; then
    if [[ "$preflight_rc" -eq 2 ]]; then
      printf 'SKIP repo=%s step=preflight-clean detail=manual-intervention-required\n' "$repo" >&2
      return 0
    fi
    fail "$repo" "preflight-clean" "preflight check failed"
  fi

  ensure_no_stash_preflight "$repo" || fail "$repo" "preflight-stash" "stash preflight logging failed"

  git -C "$repo" fetch --all --prune || fail "$repo" "fetch" "git fetch --all --prune failed"
  git -C "$repo" checkout main || fail "$repo" "checkout" "git checkout main failed"

  local ahead behind counts
  counts="$(git -C "$repo" rev-list --left-right --count origin/main...HEAD)" || fail "$repo" "branch-state" "git rev-list origin/main...HEAD failed"
  behind="${counts%%$'\t'*}"
  ahead="${counts##*$'\t'}"

  if [[ "$ahead" -gt 0 && "$behind" -gt 0 ]]; then
    fail "$repo" "branch-state" "main diverged from origin/main (ahead=$ahead behind=$behind)"
  elif [[ "$ahead" -gt 0 ]]; then
    printf 'WARN repo=%s step=branch-state detail=local-main-ahead ahead=%s behind=%s\n' "$repo" "$ahead" "$behind" >&2
    printf 'INFO repo=%s step=pull detail=skip-local-main-ahead\n' "$repo" >&2
  elif [[ "$behind" -gt 0 ]]; then
    git -C "$repo" pull --ff-only origin main || fail "$repo" "pull" "git pull --ff-only origin main failed"
  else
    printf 'INFO repo=%s step=pull detail=already-up-to-date\n' "$repo" >&2
  fi

  cleanup_local_merged_branches "$repo" || fail "$repo" "branch-cleanup" "local merged branch cleanup failed"
}

main() {
  local repo

  for repo in "${REPOS[@]}"; do
    sync_repo "$repo"
  done

  printf 'Repo auto-sync hygiene complete for %s repos.\n' "${#REPOS[@]}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
