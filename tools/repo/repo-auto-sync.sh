#!/usr/bin/env bash
set -euo pipefail

REPOS=("/Users/hd/Developer/cortana" "/Users/hd/Developer/cortana-external")
PROTECTED_BRANCHES=("main" "master" "dev" "develop")

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

  local status
  status="$(git -C "$repo" status --porcelain --untracked-files=all)"
  if [[ -n "$status" ]]; then
    printf 'WARN repo=%s step=preflight-clean detail=dirty-or-untracked-skip\n' "$repo" >&2
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      printf 'WARN repo=%s step=preflight-clean detail=status-entry entry=%q\n' "$repo" "$line" >&2
    done <<< "$status"
    return 2
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

  git -C "$repo" fetch --all --prune || fail "$repo" "fetch" "git fetch --all --prune failed"
  git -C "$repo" checkout main || fail "$repo" "checkout" "git checkout main failed"
  git -C "$repo" pull --ff-only origin main || fail "$repo" "pull" "git pull --ff-only origin main failed"

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
