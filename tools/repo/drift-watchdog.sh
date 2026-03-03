#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/Users/hd/Developer}"
REPOS=("$REPO_ROOT/cortana" "$REPO_ROOT/cortana-external")

alerts=()

for repo in "${REPOS[@]}"; do
  name="$(basename "$repo")"

  if [[ ! -d "$repo/.git" ]]; then
    alerts+=("${name}:missing_repo")
    continue
  fi

  pushd "$repo" >/dev/null

  git fetch origin --prune --quiet || true

  if ! git show-ref --verify --quiet refs/heads/main || ! git show-ref --verify --quiet refs/remotes/origin/main; then
    alerts+=("${name}:missing_main_ref")
    popd >/dev/null
    continue
  fi

  read -r ahead behind < <(git rev-list --left-right --count main...origin/main)
  tracked_dirty=$(git status --porcelain | awk 'substr($0,1,1)!="?" || substr($0,2,1)!="?"' | wc -l | tr -d ' ')
  untracked=$(git status --porcelain | awk 'substr($0,1,1)=="?" && substr($0,2,1)=="?"' | wc -l | tr -d ' ')

  if [[ "$ahead" -gt 0 || "$behind" -gt 0 || "$tracked_dirty" -gt 0 || "$untracked" -gt 0 ]]; then
    alerts+=("${name}:ahead=${ahead},behind=${behind},dirty=${tracked_dirty},untracked=${untracked}")
  fi

  popd >/dev/null
done

if [[ "${#alerts[@]}" -eq 0 ]]; then
  exit 0
fi

echo "[repo-drift-watchdog] drift detected:"
for a in "${alerts[@]}"; do
  echo " - $a"
done
exit 1
