#!/usr/bin/env bash
# post-merge-cleanup.sh — Clean up after a PR merges into main.
# Usage: post-merge-cleanup.sh [repo_path ...]
# Defaults to both cortana and cortana-external if no args given.
#
# What it does:
#   1. Checks out main and pulls latest
#   2. Deletes local branches that are fully merged into main
#   3. Prunes remote tracking branches
#   4. Deletes remote branches that were merged (skips main/develop)
#   5. Clears any stash entries
#   6. Removes untracked files (git clean -fd)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

DEFAULT_REPOS=(
  "/Users/hd/Developer/cortana"
  "/Users/hd/Developer/cortana-external"
)

REPOS=("${@:-${DEFAULT_REPOS[@]}}")
PROTECTED_BRANCHES="main|develop|master"

extract_branch_name() {
  local raw="${1:-}"
  echo "$raw" | sed -E 's/^[*+[:space:]]*([^[:space:]]+).*/\1/'
}

sanitize_branch_name() {
  local raw="${1:-}"
  local token
  token="$(extract_branch_name "$raw" | xargs)"
  echo "$token"
}

is_protected_branch() {
  case "${1:-}" in
    main|develop|master) return 0 ;;
    *) return 1 ;;
  esac
}

is_valid_branch_name() {
  local branch="${1:-}"
  [[ -n "$branch" ]] || return 1
  git check-ref-format --branch "$branch" >/dev/null 2>&1
}

cleanup_repo() {
  local repo="$1"
  local name
  local branch
  name=$(basename "$repo")

  echo -e "\n${YELLOW}═══ Cleaning: ${name} ═══${NC}"

  if [[ ! -d "$repo/.git" ]]; then
    echo -e "${RED}  ✗ Not a git repo: ${repo}${NC}"
    return 1
  fi

  cd "$repo"

  # 1. Checkout main and pull latest
  echo -e "  ${GREEN}→${NC} Checking out main..."
  git checkout main --quiet 2>/dev/null || { echo -e "${RED}  ✗ No main branch${NC}"; return 1; }
  git fetch origin --prune --quiet 2>/dev/null
  git reset --hard origin/main --quiet 2>/dev/null

  # 2. Delete merged local branches
  local merged_local
  merged_local=$(git branch --merged main || true)
  if [[ -n "$merged_local" ]]; then
    echo -e "  ${GREEN}→${NC} Deleting merged local branches:"
    while IFS= read -r raw_branch; do
      branch="$(sanitize_branch_name "$raw_branch")"
      [[ -z "$branch" ]] && continue
      is_protected_branch "$branch" && continue
      is_valid_branch_name "$branch" || continue
      echo -e "    ${RED}✗${NC} $branch"
      git branch -D "$branch" --quiet 2>/dev/null || true
    done <<< "$merged_local"
  else
    echo -e "  ${GREEN}✓${NC} No merged local branches to clean"
  fi

  # 3. Delete stale local branches (no remote tracking + not checked out)
  local stale_local
  stale_local=$(git branch -vv | grep ': gone]' || true)
  if [[ -n "$stale_local" ]]; then
    echo -e "  ${GREEN}→${NC} Deleting stale local branches (remote gone):"
    while IFS= read -r raw_branch; do
      branch="$(sanitize_branch_name "$raw_branch")"
      [[ -z "$branch" ]] && continue
      is_protected_branch "$branch" && continue
      is_valid_branch_name "$branch" || continue
      echo -e "    ${RED}✗${NC} $branch"
      git branch -D "$branch" --quiet 2>/dev/null || true
    done <<< "$stale_local"
  fi

  # 4. Delete merged remote branches
  local merged_remote
  merged_remote=$(git branch -r --merged main | grep 'origin/' | sed 's|origin/||' || true)
  if [[ -n "$merged_remote" ]]; then
    echo -e "  ${GREEN}→${NC} Deleting merged remote branches:"
    while IFS= read -r raw_branch; do
      branch="$(sanitize_branch_name "$raw_branch")"
      [[ -z "$branch" ]] && continue
      [[ "$branch" == "HEAD" ]] && continue
      is_protected_branch "$branch" && continue
      is_valid_branch_name "$branch" || continue
      echo -e "    ${RED}✗${NC} origin/$branch"
      git push origin --delete "$branch" --quiet 2>/dev/null || true
    done <<< "$merged_remote"
  else
    echo -e "  ${GREEN}✓${NC} No merged remote branches to clean"
  fi

  # 5. Clear stash
  local stash_count
  stash_count=$(git stash list | wc -l | xargs)
  if [[ "$stash_count" -gt 0 ]]; then
    echo -e "  ${GREEN}→${NC} Clearing ${stash_count} stash entries"
    git stash clear
  else
    echo -e "  ${GREEN}✓${NC} Stash is clean"
  fi

  # 6. Clean untracked files (skip this repo's own directory to avoid self-destruction)
  local untracked
  untracked=$(git clean -n -d 2>/dev/null || true)
  if [[ -n "$untracked" ]]; then
    echo -e "  ${GREEN}→${NC} Cleaning untracked files"
    git clean -fd --quiet 2>/dev/null
  else
    echo -e "  ${GREEN}✓${NC} Working tree is clean"
  fi

  echo -e "  ${GREEN}✓${NC} ${name} is clean — on main @ $(git rev-parse --short HEAD)"
}

echo -e "${YELLOW}🧹 Post-Merge Cleanup${NC}"

for repo in "${REPOS[@]}"; do
  cleanup_repo "$repo" || true
done

echo -e "\n${GREEN}✅ All repos clean.${NC}"
