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
  "memory/heartbeat-state.json"
)
VOLATILE_STATUS_PREFIXES=(
  "var/backtests/runs/"
)
PROMOTABLE_MEMORY_FILES=(
  "DREAMS.md"
)
PROMOTABLE_MEMORY_PREFIXES=(
  "memory/.dreams/"
  "memory/dreaming/"
)
PROMOTABLE_MEMORY_GLOBS=(
  "identities/*/DREAMS.md"
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

resolve_main_remote_ref() {
  local repo="$1"
  local upstream=""
  local candidate=""

  upstream="$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name main@{upstream} 2>/dev/null || true)"
  if [[ -n "$upstream" ]]; then
    printf '%s\n' "$upstream"
    return 0
  fi

  for candidate in "origin/main" "upstream/main"; do
    if git -C "$repo" show-ref --verify --quiet "refs/remotes/$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

main_remote_components() {
  local remote_ref="$1"
  local remote="${remote_ref%%/*}"
  local branch="${remote_ref#*/}"
  printf '%s\t%s\n' "$remote" "$branch"
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

status_line_path() {
  local line="$1"
  local path="${line:3}"
  path="${path##* -> }"
  printf '%s\n' "$path"
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

status_nonvolatile_lines() {
  local status="$1"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if ! status_line_is_volatile "$line"; then
      printf '%s\n' "$line"
    fi
  done <<< "$status"
}

tracked_status_paths() {
  local status="$1"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    status_line_path "$line"
  done < <(status_tracked_lines "$status")
}

status_nonvolatile_paths() {
  local status="$1"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    status_line_path "$line"
  done < <(status_nonvolatile_lines "$status")
}

path_is_promotable_memory() {
  local path="$1"
  local rel
  local prefix
  local glob

  for rel in "${PROMOTABLE_MEMORY_FILES[@]}"; do
    if [[ "$path" == "$rel" ]]; then
      return 0
    fi
  done

  for prefix in "${PROMOTABLE_MEMORY_PREFIXES[@]}"; do
    if [[ "$path" == "$prefix"* ]]; then
      return 0
    fi
  done

  for glob in "${PROMOTABLE_MEMORY_GLOBS[@]}"; do
    if [[ "$path" == $glob ]]; then
      return 0
    fi
  done

  return 1
}

path_is_dream_memory() {
  local path="$1"

  if [[ "$path" == "DREAMS.md" || "$path" == memory/.dreams/* || "$path" == memory/dreaming/* || "$path" == identities/*/DREAMS.md ]]; then
    return 0
  fi

  return 1
}

status_is_promotable_memory_only() {
  local status="$1"
  local saw_path=1
  local path=""

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    saw_path=0
    if ! path_is_promotable_memory "$path"; then
      return 1
    fi
  done < <(status_nonvolatile_paths "$status")

  return "$saw_path"
}

promotable_memory_slug() {
  local status="$1"
  local path=""

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    if ! path_is_dream_memory "$path"; then
      printf 'memory-artifacts\n'
      return 0
    fi
  done < <(status_nonvolatile_paths "$status")

  printf 'dream-memory\n'
}

join_by_comma() {
  local result=""
  local value=""

  for value in "$@"; do
    if [[ -n "$result" ]]; then
      result+=","
    fi
    result+="$value"
  done

  printf '%s\n' "$result"
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

create_or_find_pr_for_branch() {
  local repo="$1"
  local branch="$2"
  local title="$3"
  local body="$4"

  local create_out=""
  local create_rc=0
  local pr_url=""

  set +e
  create_out="$(git -C "$repo" rev-parse --show-toplevel >/dev/null 2>&1 && cd "$repo" && gh pr create --draft --base main --head "$branch" --title "$title" --body "$body" 2>&1)"
  create_rc=$?
  set -e

  if [[ "$create_rc" -eq 0 ]]; then
    pr_url="$(printf '%s\n' "$create_out" | grep -Eo 'https://github.com/[^ ]+/pull/[0-9]+' | tail -n1 || true)"
  fi

  if [[ -z "$pr_url" ]]; then
    set +e
    pr_url="$(cd "$repo" && gh pr list --head "$branch" --json url --limit 1 2>/dev/null | python3 -c 'import json,sys
try:
    payload=json.load(sys.stdin)
except Exception:
    payload=[]
if isinstance(payload, list) and payload:
    print(payload[0].get("url", ""))')"
    create_rc=$?
    set -e
    if [[ "$create_rc" -ne 0 ]]; then
      pr_url=""
    fi
  fi

  printf '%s\n' "$pr_url"
}

branch_is_promotable_memory_branch() {
  local branch="${1:-}"

  case "$branch" in
    codex/promote-dream-memory-*|codex/promote-memory-artifacts-*)
      return 0
      ;;
  esac

  return 1
}

finalize_promotable_memory_branch() {
  local repo="$1"
  local status="$2"
  local branch_name="$3"
  local branch_slug commit_msg pr_title pr_body branch_files file_list
  local paths=()
  local path=""
  local pr_url=""
  local commit_sha=""
  local promotion_ok=1

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    paths+=("$path")
  done < <(status_nonvolatile_paths "$status")

  if (( ${#paths[@]} == 0 )); then
    return 1
  fi

  branch_slug="$(promotable_memory_slug "$status")"
  branch_files="$(join_by_comma "${paths[@]}")"

  if [[ "$branch_slug" == "dream-memory" ]]; then
    commit_msg="chore(memory): promote dream memory state"
    pr_title="[codex] Promote dream memory state"
  else
    commit_msg="chore(memory): promote memory artifacts"
    pr_title="[codex] Promote memory artifacts"
  fi

  file_list="$(for path in "${paths[@]}"; do printf -- '- `%s`\n' "$path"; done)"
  pr_body=$(cat <<EOF
## Summary
- promote dream and memory artifacts detected during repo auto-sync
- preserve dreaming and runtime-derived memory state instead of treating it as disposable dirt
- return local main to a clean state so sync/deploy automation can continue

## Files
$file_list
EOF
)

  if ! git -C "$repo" add -- "${paths[@]}" >/dev/null 2>&1; then
    queue_actionable_alert "$repo" "preflight-clean" "promotable-memory-stage-failed branch=$branch_name files=$branch_files"
    return 1
  fi

  if ! git -C "$repo" diff --cached --quiet -- "${paths[@]}"; then
    if ! git -C "$repo" commit -m "$commit_msg" >/dev/null 2>&1; then
      queue_actionable_alert "$repo" "preflight-clean" "promotable-memory-commit-failed branch=$branch_name files=$branch_files"
      return 1
    fi
  else
    printf 'INFO repo=%s step=preflight-clean detail=promotable-memory-no-new-commit branch=%q\n' \
      "$repo" "$branch_name" >&2
  fi

  commit_sha="$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)"

  if ! git -C "$repo" push -u origin "$branch_name" >/dev/null 2>&1; then
    queue_actionable_alert "$repo" "preflight-clean" "promotable-memory-push-failed branch=$branch_name commit=${commit_sha:-unknown}"
    promotion_ok=0
  else
    pr_url="$(create_or_find_pr_for_branch "$repo" "$branch_name" "$pr_title" "$pr_body")"
    if [[ -n "$pr_url" ]]; then
      queue_actionable_alert "$repo" "preflight-clean" "promotable-memory-pr-opened branch=$branch_name pr_url=$pr_url files=$branch_files"
      printf 'INFO repo=%s step=preflight-clean detail=promotable-memory-pr-opened branch=%q pr_url=%q files=%q\n' \
        "$repo" "$branch_name" "$pr_url" "$branch_files" >&2
    else
      queue_actionable_alert "$repo" "preflight-clean" "promotable-memory-branch-pushed-no-pr branch=$branch_name commit=${commit_sha:-unknown}"
      promotion_ok=0
    fi
  fi

  if ! git -C "$repo" checkout main >/dev/null 2>&1; then
    queue_actionable_alert "$repo" "preflight-clean" "promotable-memory-return-main-failed branch=$branch_name"
    return 1
  fi

  if [[ "$promotion_ok" -ne 0 ]]; then
    return 0
  fi

  return 1
}

promote_promotable_memory_state() {
  local repo="$1"
  local status="$2"
  local branch_slug branch_name ts

  branch_slug="$(promotable_memory_slug "$status")"
  ts="$(date -u +%Y%m%d-%H%M%S)"
  branch_name="codex/promote-${branch_slug}-${ts}"

  if ! git -C "$repo" checkout -b "$branch_name" >/dev/null 2>&1; then
    queue_actionable_alert "$repo" "preflight-clean" "promotable-memory-branch-create-failed branch=$branch_name"
    return 1
  fi

  finalize_promotable_memory_branch "$repo" "$status" "$branch_name"
}

resume_promotable_memory_state() {
  local repo="$1"
  local status="$2"
  local branch_name="$3"

  printf 'INFO repo=%s step=preflight-clean detail=promotable-memory-branch-resume branch=%q\n' \
    "$repo" "$branch_name" >&2
  finalize_promotable_memory_branch "$repo" "$status" "$branch_name"
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

branch_is_merged_into_main_remote() {
  local repo="$1"
  local branch="$2"
  local main_remote_ref=""

  git -C "$repo" show-ref --verify --quiet "refs/heads/$branch" || return 1
  main_remote_ref="$(resolve_main_remote_ref "$repo")" || return 1
  git -C "$repo" rev-parse --verify --quiet "$main_remote_ref" >/dev/null || return 1
  git -C "$repo" merge-base --is-ancestor "$branch" "$main_remote_ref"
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

    if [[ -n "$branch_name" ]] && branch_is_merged_into_main_remote "$repo" "$branch_name"; then
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

  local current_branch
  current_branch="$(git -C "$repo" branch --show-current 2>/dev/null || true)"

  if status_is_promotable_memory_only "$status"; then
    if [[ "$current_branch" == "main" ]]; then
      if promote_promotable_memory_state "$repo" "$status"; then
        return 0
      fi
      return 3
    fi

    if branch_is_promotable_memory_branch "$current_branch"; then
      if resume_promotable_memory_state "$repo" "$status" "$current_branch"; then
        return 0
      fi
      return 3
    fi
  fi

  local tracked_status=""
  tracked_status="$(status_tracked_lines "$status")"

  if [[ -z "$tracked_status" ]]; then
    printf 'WARN repo=%s step=preflight-clean detail=untracked-only-continue\n' "$repo" >&2
    return 0
  fi

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
  local main_remote_ref=""

  main_remote_ref="$(resolve_main_remote_ref "$repo")" || {
    queue_actionable_alert "$repo" "branch-cleanup" "missing-main-remote-ref"
    return 0
  }

  git -C "$repo" for-each-ref --format='%(refname:short)' refs/heads --merged "$main_remote_ref" \
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

  local ahead behind counts main_remote_ref pull_remote pull_branch
  main_remote_ref="$(resolve_main_remote_ref "$repo")" || fail "$repo" "branch-state" "unable to resolve tracked main remote ref"
  counts="$(git -C "$repo" rev-list --left-right --count "$main_remote_ref...HEAD")" || fail "$repo" "branch-state" "git rev-list $main_remote_ref...HEAD failed"
  behind="${counts%%$'\t'*}"
  ahead="${counts##*$'\t'}"

  if [[ "$ahead" -gt 0 && "$behind" -gt 0 ]]; then
    queue_actionable_alert "$repo" "branch-state" "diverged-main-manual-intervention-required ahead=$ahead behind=$behind"
    return 0
  elif [[ "$ahead" -gt 0 ]]; then
    queue_actionable_alert "$repo" "branch-state" "local-main-ahead remote_ref=$main_remote_ref ahead=$ahead behind=$behind"
  elif [[ "$behind" -gt 0 ]]; then
    IFS=$'\t' read -r pull_remote pull_branch < <(main_remote_components "$main_remote_ref")
    if ! git -C "$repo" pull --ff-only "$pull_remote" "$pull_branch" >/dev/null 2>&1; then
      queue_actionable_alert "$repo" "pull" "git pull --ff-only $pull_remote $pull_branch failed"
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
