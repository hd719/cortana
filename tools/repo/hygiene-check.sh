#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/Users/hd/Developer}"
REPOS=("$REPO_ROOT/cortana" "$REPO_ROOT/cortana-external")

FIX_MODE=false
CONFIRM_DESTRUCTIVE=false
EXECUTE=false

usage() {
  cat <<'EOF'
Pre-flight branch hygiene check for cortana + cortana-external.

Usage:
  hygiene-check.sh [--fix --confirm-destructive [--execute]]

Flags:
  --fix                  Enable remediation path.
  --confirm-destructive  Required with --fix to allow destructive cleanup actions.
  --execute              Execute cleanup actions (default is dry-run preview).
  -h, --help             Show this help.

Notes:
- Without --fix, this command is read-only.
- With --fix and no --execute, actions are previewed only.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --fix) FIX_MODE=true ;;
    --confirm-destructive) CONFIRM_DESTRUCTIVE=true ;;
    --execute) EXECUTE=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; usage; exit 2 ;;
  esac
done

if [[ "$FIX_MODE" == true && "$CONFIRM_DESTRUCTIVE" != true ]]; then
  echo "ERROR: --fix requires --confirm-destructive" >&2
  exit 2
fi

run_or_echo() {
  if [[ "$EXECUTE" == true ]]; then
    "$@"
  else
    echo "[dry-run] $*"
  fi
}

count_tracked_dirty() {
  git status --porcelain | awk 'substr($0,1,1)!="?" || substr($0,2,1)!="?"' | wc -l | tr -d ' '
}

count_untracked() {
  git status --porcelain | awk 'substr($0,1,1)=="?" && substr($0,2,1)=="?"' | wc -l | tr -d ' '
}

overall_rc=0

printf "\n== Repo hygiene check ==\n"
printf "repo_root=%s\n" "$REPO_ROOT"

for repo in "${REPOS[@]}"; do
  name="$(basename "$repo")"
  printf "\n[%s]\n" "$name"

  if [[ ! -d "$repo/.git" ]]; then
    echo "missing repo: $repo"
    overall_rc=1
    continue
  fi

  pushd "$repo" >/dev/null

  git fetch origin --prune --quiet

  if ! git show-ref --verify --quiet refs/heads/main; then
    echo "missing local main branch"
    overall_rc=1
    popd >/dev/null
    continue
  fi

  current_branch="$(git rev-parse --abbrev-ref HEAD)"

  # Ensure main tracks origin/main
  if git show-ref --verify --quiet refs/remotes/origin/main; then
    upstream="$(git rev-parse --abbrev-ref --symbolic-full-name main@{upstream} 2>/dev/null || true)"
    if [[ "$upstream" != "origin/main" ]]; then
      git branch --set-upstream-to=origin/main main >/dev/null
      echo "set upstream: main -> origin/main"
    fi
  else
    echo "missing origin/main remote ref"
    overall_rc=1
  fi

  ahead=0
  behind=0
  if git show-ref --verify --quiet refs/remotes/origin/main; then
    read -r ahead behind < <(git rev-list --left-right --count main...origin/main)
  fi

  tracked_dirty="$(count_tracked_dirty)"
  untracked="$(count_untracked)"
  stash_count="$(git stash list | wc -l | tr -d ' ')"

  printf "branch=%s ahead=%s behind=%s tracked_dirty=%s untracked=%s stash=%s\n" \
    "$current_branch" "$ahead" "$behind" "$tracked_dirty" "$untracked" "$stash_count"

  if [[ "$FIX_MODE" == true ]]; then
    if [[ "$EXECUTE" == true ]]; then
      echo "fix mode: execute"
    else
      echo "fix mode: dry-run"
    fi
    run_or_echo git checkout main
    run_or_echo git reset --hard origin/main
    run_or_echo git clean -fd
    run_or_echo git stash clear
  fi

  popd >/dev/null
done

exit "$overall_rc"
