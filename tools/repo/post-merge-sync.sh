#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/Users/hd/Developer}"
REPOS=("$REPO_ROOT/cortana" "$REPO_ROOT/cortana-external")

printf "== Post-merge sync (main <- origin/main) ==\n"
printf "repo_root=%s\n\n" "$REPO_ROOT"

overall_rc=0
printf "%-18s %-8s %-12s %s\n" "repo" "result" "ahead/behind" "note"
printf "%-18s %-8s %-12s %s\n" "------------------" "--------" "------------" "-------------------------------"

for repo in "${REPOS[@]}"; do
  name="$(basename "$repo")"

  if [[ ! -d "$repo/.git" ]]; then
    printf "%-18s %-8s %-12s %s\n" "$name" "FAIL" "-" "repo missing"
    overall_rc=1
    continue
  fi

  pushd "$repo" >/dev/null

  git fetch origin --prune --quiet || true

  if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    printf "%-18s %-8s %-12s %s\n" "$name" "SKIP" "-" "dirty working tree"
    overall_rc=1
    popd >/dev/null
    continue
  fi

  if ! git show-ref --verify --quiet refs/heads/main || ! git show-ref --verify --quiet refs/remotes/origin/main; then
    printf "%-18s %-8s %-12s %s\n" "$name" "FAIL" "-" "missing main/origin-main"
    overall_rc=1
    popd >/dev/null
    continue
  fi

  git checkout main --quiet
  git branch --set-upstream-to=origin/main main >/dev/null 2>&1 || true
  git pull --ff-only --quiet origin main || true

  read -r ahead behind < <(git rev-list --left-right --count main...origin/main)

  if [[ "$ahead" -eq 0 && "$behind" -eq 0 ]] && git diff --quiet && git diff --cached --quiet && [[ -z "$(git ls-files --others --exclude-standard)" ]]; then
    printf "%-18s %-8s %-12s %s\n" "$name" "OK" "$ahead/$behind" "clean + synced"
  else
    printf "%-18s %-8s %-12s %s\n" "$name" "FAIL" "$ahead/$behind" "drift or dirty after sync"
    overall_rc=1
  fi

  popd >/dev/null
done

exit "$overall_rc"
