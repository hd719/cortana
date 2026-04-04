#!/usr/bin/env bash
set -euo pipefail

PRIMARY_REPO="${PRIMARY_REPO:-/Users/hd/Developer/cortana}"
DEPLOY_REPO="${DEPLOY_REPO:-/Users/hd/Developer/cortana-deploy}"
BRANCH="${BRANCH:-main}"

usage() {
  cat <<'USAGE'
Ensure a clean deploy worktree that tracks origin/main.

Usage:
  ensure-deploy-worktree.sh [--primary-repo <path>] [--deploy-repo <path>] [--branch <name>]
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --primary-repo) PRIMARY_REPO="$2"; shift 2 ;;
    --deploy-repo) DEPLOY_REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ -d "$PRIMARY_REPO/.git" ]] || { echo "primary repo missing: $PRIMARY_REPO" >&2; exit 1; }
git -C "$PRIMARY_REPO" fetch origin "$BRANCH" --prune --quiet

if [[ ! -e "$DEPLOY_REPO" ]]; then
  git -C "$PRIMARY_REPO" worktree add "$DEPLOY_REPO" "origin/$BRANCH" >/dev/null
fi

[[ -d "$DEPLOY_REPO/.git" || -f "$DEPLOY_REPO/.git" ]] || { echo "deploy repo invalid: $DEPLOY_REPO" >&2; exit 1; }
status="$(git -C "$DEPLOY_REPO" status --porcelain --untracked-files=all)"
[[ -z "$status" ]] || { echo "deploy repo has local changes: $DEPLOY_REPO" >&2; exit 1; }
branch="$(git -C "$DEPLOY_REPO" rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "$BRANCH" ]] || git -C "$DEPLOY_REPO" checkout "$BRANCH" >/dev/null 2>&1
upstream="$(git -C "$DEPLOY_REPO" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true)"
[[ "$upstream" == "origin/$BRANCH" ]] || git -C "$DEPLOY_REPO" branch --set-upstream-to "origin/$BRANCH" "$BRANCH" >/dev/null
git -C "$DEPLOY_REPO" pull --ff-only --quiet origin "$BRANCH"
printf '%s\n' "$DEPLOY_REPO"
