#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/Users/hd/Developer}"
DEFAULT_REPOS=("$REPO_ROOT/cortana" "$REPO_ROOT/cortana-external")
REPOS=()
PROTECTED_BRANCHES=("main" "master" "dev" "develop")
VOLATILE_STATE_FILES=(
  "memory/calendar-reminders-sent.json"
  "memory/apple-reminders-sent.json"
  "memory/newsletter-alerted.json"
  "memory/x-trending-seen.json"
  "memory/circuit-breaker-state.json"
  "memory/cron-health-48h.json"
  "memory/cron-health-48h-errors.json"
)
VOLATILE_STATUS_PREFIXES=(
  "var/backtests/runs/"
)

DIRTY_MAIN_STALE_HOURS="${DIRTY_MAIN_STALE_HOURS:-6}"
STALE_TEMP_WORKTREE_HOURS="${STALE_TEMP_WORKTREE_HOURS:-24}"
POST_MERGE_MODE=false
ALERT_STATE_FILE="${REPO_AUTO_SYNC_ALERT_STATE_FILE:-$HOME/.openclaw/tmp/repo-auto-sync-state.txt}"

ACTIONABLE_ALERTS=()

usage() {
  cat <<'EOF'
Safe repo hygiene sync for local worktrees and merged branches.

Usage:
  repo-auto-sync.sh [--repo <path>] [--repo-root <path>] [--post-merge]

Flags:
  --repo <path>       Limit to a specific repo. May be repeated.
  --repo-root <path>  Build default repo list from this root.
  --post-merge        Strict mode: require merged-cleanup outcome on local main.
  -h, --help          Show this help.

Output:
  - `NO_REPLY` when all repos are healthy or only safe auto-clean happened.
  - Concise actionable lines when manual intervention is required.
EOF
}

fail() {
  local repo="$1"
  local step="$2"
  local detail="$3"
  printf 'FAIL repo=%s step=%s detail=%s\n' "$repo" "$step" "$detail" >&2
  return 1
}

queue_actionable_alert() {
  local repo="$1"
  local step="$2"
  local detail="$3"
  ACTIONABLE_ALERTS+=("repo=$(basename "$repo") step=$step detail=$detail")
}

ensure_alert_state_dir() {
  mkdir -p "$(dirname "$ALERT_STATE_FILE")" >/dev/null 2>&1 || true
}

read_alert_fingerprint() {
  if [[ -f "$ALERT_STATE_FILE" ]]; then
    cat "$ALERT_STATE_FILE"
  fi
}

write_alert_fingerprint() {
  local fingerprint="$1"
  ensure_alert_state_dir
  printf '%s\n' "$fingerprint" > "$ALERT_STATE_FILE" 2>/dev/null || true
}

clear_alert_fingerprint() {
  rm -f "$ALERT_STATE_FILE" 2>/dev/null || true
}

alert_fingerprint() {
  if (( ${#ACTIONABLE_ALERTS[@]} == 0 )); then
    return 1
  fi

  printf '%s\n' "${ACTIONABLE_ALERTS[@]}" \
    | LC_ALL=C sort \
    | shasum -a 1 \
    | awk '{print $1}'
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
  local worktree_path="${1%/}/"
  [[ "$worktree_path" == /tmp/* || "$worktree_path" == /private/tmp/* ]]
}

path_mtime_epoch() {
  local target="$1"
  local mtime=""

  mtime="$(stat -f '%m' "$target" 2>/dev/null || true)"
  if [[ -z "$mtime" ]]; then
    mtime="$(stat -c '%Y' "$target" 2>/dev/null || true)"
  fi

  if [[ "$mtime" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$mtime"
    return 0
  fi

  return 1
}

status_line_is_volatile() {
  local line="$1"
  local path="${line:3}"
  path="${path##* -> }"
  local prefix

  for prefix in "${VOLATILE_STATUS_PREFIXES[@]}"; do
    if [[ "$path" == "$prefix"* ]]; then
      return 0
    fi
  done

  return 1
}

status_tracked_lines() {
  local status="$1"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "${line:0:2}" != "??" ]] && ! status_line_is_volatile "$line"; then
      printf '%s\n' "$line"
    fi
  done <<< "$status"
}

newest_status_path_age_seconds() {
  local repo="$1"
  local status="$2"
  local now path full_path mtime age newest=0
  now="$(date +%s)"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    path="${line:3}"
    path="${path##* -> }"
    full_path="$repo/$path"
    if ! mtime="$(path_mtime_epoch "$full_path")"; then
      continue
    fi
    age=$(( now - mtime ))
    if (( age > newest )); then
      newest="$age"
    fi
  done < <(status_tracked_lines "$status")

  printf '%s\n' "$newest"
}

restore_volatile_runtime_state() {
  local repo="$1"
  local restored=()
  local rel
  local prefix

  for rel in "${VOLATILE_STATE_FILES[@]}"; do
    if git -C "$repo" status --porcelain -- "$rel" | grep -q .; then
      if git -C "$repo" restore --worktree -- "$rel" >/dev/null 2>&1; then
        restored+=("$rel")
      fi
    fi
  done

  for prefix in "${VOLATILE_STATUS_PREFIXES[@]}"; do
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      if [[ "${line:0:2}" == "??" ]]; then
        continue
      fi
      local path="${line:3}"
      path="${path##* -> }"
      if git -C "$repo" restore --worktree -- "$path" >/dev/null 2>&1; then
        restored+=("$path")
      fi
    done < <(git -C "$repo" status --porcelain -- "$prefix")
  done

  if (( ${#restored[@]} > 0 )); then
    printf 'INFO repo=%s step=preflight-clean detail=volatile-runtime-state-restored files=%q\n' \
      "$repo" "${restored[*]}" >&2
  fi
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

list_all_worktrees() {
  local repo="$1"
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
      if [[ -n "$current_worktree" ]]; then
        printf '%s\t%s\n' "$current_worktree" "$current_branch"
      fi
      current_worktree=""
      current_branch=""
    fi
  done < <(git -C "$repo" worktree list --porcelain; printf '\n')
}

worktree_branch_name_from_ref() {
  local ref="${1:-}"
  if [[ "$ref" == refs/heads/* ]]; then
    printf '%s\n' "${ref#refs/heads/}"
  fi
}

branch_is_merged_into_origin_main() {
  local repo="$1"
  local branch="$2"

  git -C "$repo" show-ref --verify --quiet "refs/heads/$branch" || return 1
  git -C "$repo" rev-parse --verify --quiet "origin/main" >/dev/null || return 1
  git -C "$repo" merge-base --is-ancestor "$branch" "origin/main"
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
    queue_actionable_alert "$repo" "branch-cleanup" "merged-branch-blocked-non-temp-worktree branch=$branch worktree=$worktree_path"
    return 1
  fi

  if auto_stash_dirty_worktree "$repo" "$branch" "$worktree_path"; then
    if git -C "$repo" worktree remove -- "$worktree_path" >/dev/null 2>&1; then
      printf 'INFO repo=%s step=branch-cleanup detail=temp-worktree-removed branch=%q worktree=%q\n' "$repo" "$branch" "$worktree_path" >&2
      return 0
    fi
    printf 'WARN repo=%s step=branch-cleanup detail=temp-worktree-remove-failed branch=%q worktree=%q\n' "$repo" "$branch" "$worktree_path" >&2
  fi

  queue_actionable_alert "$repo" "branch-cleanup" "merged-branch-temp-worktree-remove-failed branch=$branch worktree=$worktree_path"
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
      queue_actionable_alert "$repo" "branch-cleanup" "merged-branch-checked-out-in-primary-worktree branch=$branch"
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

cleanup_stale_temp_worktrees() {
  local repo="$1"
  local threshold_seconds=$(( STALE_TEMP_WORKTREE_HOURS * 3600 ))
  local now age_seconds branch_ref branch_name worktree_path status
  now="$(date +%s)"

  while IFS=$'\t' read -r worktree_path branch_ref; do
    [[ -n "$worktree_path" ]] || continue
    [[ "$worktree_path" == "$repo" ]] && continue
    is_temp_worktree_path "$worktree_path" || continue

    local mtime
    if ! mtime="$(path_mtime_epoch "$worktree_path")"; then
      continue
    fi

    age_seconds=$(( now - mtime ))
    if (( age_seconds < threshold_seconds )); then
      continue
    fi

    branch_name="$(worktree_branch_name_from_ref "$branch_ref")"
    status="$(git -C "$worktree_path" status --porcelain --untracked-files=all 2>/dev/null || true)"

    if [[ -n "$branch_name" ]] && branch_is_merged_into_origin_main "$repo" "$branch_name"; then
      if remove_temp_worktree_for_branch "$repo" "$branch_name" "$worktree_path"; then
        printf 'INFO repo=%s step=stale-temp-worktree detail=stale-temp-worktree-removed branch=%q worktree=%q age_hours=%s\n' \
          "$repo" "$branch_name" "$worktree_path" "$(( age_seconds / 3600 ))" >&2
      fi
      continue
    fi

    if [[ -z "$branch_name" && -z "$status" ]]; then
      if git -C "$repo" worktree remove -- "$worktree_path" >/dev/null 2>&1; then
        printf 'INFO repo=%s step=stale-temp-worktree detail=detached-clean-temp-worktree-removed worktree=%q age_hours=%s\n' \
          "$repo" "$worktree_path" "$(( age_seconds / 3600 ))" >&2
        continue
      fi
    fi

    if [[ -n "$branch_name" ]] && ! git -C "$repo" show-ref --verify --quiet "refs/heads/$branch_name" && [[ -z "$status" ]]; then
      if git -C "$repo" worktree remove -- "$worktree_path" >/dev/null 2>&1; then
        printf 'INFO repo=%s step=stale-temp-worktree detail=orphan-clean-temp-worktree-removed branch=%q worktree=%q age_hours=%s\n' \
          "$repo" "$branch_name" "$worktree_path" "$(( age_seconds / 3600 ))" >&2
        continue
      fi
    fi

    queue_actionable_alert \
      "$repo" \
      "stale-temp-worktree" \
      "manual-review-required worktree=$worktree_path branch=${branch_name:-detached} age_hours=$(( age_seconds / 3600 )) dirty=$([[ -n "$status" ]] && printf yes || printf no)"
  done < <(list_all_worktrees "$repo")
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

ensure_clean_preflight() {
  local repo="$1"

  restore_volatile_runtime_state "$repo"

  local status
  status="$(git -C "$repo" status --porcelain --untracked-files=all)"
  if [[ -z "$status" ]]; then
    return 0
  fi

  local tracked_status=""
  tracked_status="$(status_tracked_lines "$status")"

  if [[ -z "$tracked_status" ]]; then
    printf 'WARN repo=%s step=preflight-clean detail=untracked-only-continue\n' "$repo" >&2
    return 0
  fi

  local current_branch
  current_branch="$(git -C "$repo" branch --show-current 2>/dev/null || true)"

  if [[ "$current_branch" != "main" ]]; then
    if [[ "$POST_MERGE_MODE" == true ]]; then
      queue_actionable_alert "$repo" "preflight-clean" "post-merge-blocked-dirty-non-main branch=${current_branch:-detached}"
      return 3
    fi
    printf 'WARN repo=%s step=preflight-clean detail=feature-branch-dirty-expected branch=%q\n' "$repo" "$current_branch" >&2
    return 2
  fi

  local newest_age_seconds threshold_seconds
  newest_age_seconds="$(newest_status_path_age_seconds "$repo" "$tracked_status")"
  threshold_seconds=$(( DIRTY_MAIN_STALE_HOURS * 3600 ))

  if (( newest_age_seconds > threshold_seconds )) || [[ "$POST_MERGE_MODE" == true ]]; then
    queue_actionable_alert \
      "$repo" \
      "preflight-clean" \
      "dirty-main-manual-intervention-required age_hours=$(( newest_age_seconds / 3600 ))"
    printf 'WARN repo=%s step=preflight-clean detail=dirty-main-manual-intervention-required age_hours=%s\n' \
      "$repo" "$(( newest_age_seconds / 3600 ))" >&2
    return 3
  fi

  printf 'WARN repo=%s step=preflight-clean detail=dirty-main-fresh-expected age_hours=%s\n' \
    "$repo" "$(( newest_age_seconds / 3600 ))" >&2
  return 2
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

        if git -C "$repo" branch -d -- "$b" >/dev/null 2>&1; then
          printf 'INFO repo=%s step=branch-cleanup detail=merged-local-branch-deleted branch=%q\n' "$repo" "$b" >&2
        else
          printf 'INFO repo=%s step=branch-cleanup detail=delete-skipped branch=%q\n' "$repo" "$b" >&2
          queue_actionable_alert "$repo" "branch-cleanup" "merged-local-branch-delete-skipped branch=$b"
        fi
      done
}

verify_repo_clean() {
  local repo="$1"

  restore_volatile_runtime_state "$repo"
  local status current_branch
  status="$(git -C "$repo" status --porcelain --untracked-files=all)"
  current_branch="$(git -C "$repo" branch --show-current 2>/dev/null || true)"

  if [[ "$current_branch" != "main" && "$POST_MERGE_MODE" == true ]]; then
    queue_actionable_alert "$repo" "verify-clean" "post-merge-ended-off-main branch=${current_branch:-detached}"
    return 1
  fi

  local tracked_status
  tracked_status="$(status_tracked_lines "$status")"
  if [[ -n "$tracked_status" && "$current_branch" == "main" ]]; then
    queue_actionable_alert "$repo" "verify-clean" "dirty-main-after-sync"
    return 1
  fi

  return 0
}

sync_repo() {
  local repo="$1"

  [[ -d "$repo/.git" ]] || fail "$repo" "preflight-repo" "missing git repo"

  local preflight_rc=0
  ensure_clean_preflight "$repo" || preflight_rc=$?
  if [[ "$preflight_rc" -ne 0 ]]; then
    if [[ "$preflight_rc" -eq 2 ]]; then
      if [[ "$POST_MERGE_MODE" == true ]]; then
        queue_actionable_alert "$repo" "preflight-clean" "post-merge-blocked-inflight-worktree"
      fi
      return 0
    fi
    if [[ "$preflight_rc" -eq 3 ]]; then
      return 0
    fi
    fail "$repo" "preflight-clean" "preflight check failed"
  fi

  ensure_no_stash_preflight "$repo" || fail "$repo" "preflight-stash" "stash preflight logging failed"

  if ! git -C "$repo" fetch --all --prune; then
    queue_actionable_alert "$repo" "fetch" "git fetch --all --prune failed"
    return 0
  fi
  cleanup_stale_temp_worktrees "$repo"
  git -C "$repo" checkout main >/dev/null 2>&1 || fail "$repo" "checkout" "git checkout main failed"

  local ahead behind counts
  counts="$(git -C "$repo" rev-list --left-right --count origin/main...HEAD)" || fail "$repo" "branch-state" "git rev-list origin/main...HEAD failed"
  behind="${counts%%$'\t'*}"
  ahead="${counts##*$'\t'}"

  if [[ "$ahead" -gt 0 && "$behind" -gt 0 ]]; then
    queue_actionable_alert "$repo" "branch-state" "diverged-main-manual-intervention-required ahead=$ahead behind=$behind"
    return 0
  elif [[ "$ahead" -gt 0 ]]; then
    queue_actionable_alert "$repo" "branch-state" "local-main-ahead ahead=$ahead behind=$behind"
  elif [[ "$behind" -gt 0 ]]; then
    if ! git -C "$repo" pull --ff-only origin main >/dev/null 2>&1; then
      queue_actionable_alert "$repo" "pull" "git pull --ff-only origin main failed"
      return 0
    fi
  else
    printf 'INFO repo=%s step=pull detail=already-up-to-date\n' "$repo" >&2
  fi

  cleanup_local_merged_branches "$repo" || fail "$repo" "branch-cleanup" "local merged branch cleanup failed"
  verify_repo_clean "$repo" || true
}

render_output() {
  if (( ${#ACTIONABLE_ALERTS[@]} == 0 )); then
    clear_alert_fingerprint
    printf 'NO_REPLY\n'
    return
  fi

  local fingerprint previous
  fingerprint="$(alert_fingerprint)"
  previous="$(read_alert_fingerprint)"

  if [[ -n "$fingerprint" && "$fingerprint" == "$previous" ]]; then
    printf 'INFO step=alert detail=unchanged-actionable-state-suppressed fingerprint=%s\n' "$fingerprint" >&2
    printf 'NO_REPLY\n'
    return
  fi

  if [[ -n "$fingerprint" ]]; then
    write_alert_fingerprint "$fingerprint"
  fi

  printf '🧹 Repo Hygiene Watcher\n'
  local line
  while IFS= read -r line; do
    printf -- '- %s\n' "$line"
  done < <(printf '%s\n' "${ACTIONABLE_ALERTS[@]}" | LC_ALL=C sort)
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo)
        [[ $# -ge 2 ]] || { usage >&2; exit 2; }
        REPOS+=("$2")
        shift 2
        ;;
      --repo-root)
        [[ $# -ge 2 ]] || { usage >&2; exit 2; }
        REPO_ROOT="$2"
        DEFAULT_REPOS=("$REPO_ROOT/cortana" "$REPO_ROOT/cortana-external")
        shift 2
        ;;
      --post-merge)
        POST_MERGE_MODE=true
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
  done

  if (( ${#REPOS[@]} == 0 )); then
    REPOS=("${DEFAULT_REPOS[@]}")
  fi

  local repo
  for repo in "${REPOS[@]}"; do
    sync_repo "$repo"
  done

  render_output
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
