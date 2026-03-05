#!/usr/bin/env bash
set -euo pipefail

# Agent PR lifecycle helper:
# 1) sync local main with origin/main
# 2) create ephemeral temp worktree + feature branch
# 3) run task command inside isolated worktree
# 4) if changes exist, commit + push + open PR
# 5) cleanup: remove temp worktree and return primary repo to clean main

REPO="${REPO:-/Users/hd/Developer/cortana}"
BASE_BRANCH="${BASE_BRANCH:-main}"
BRANCH_PREFIX="${BRANCH_PREFIX:-agent}"
COMMIT_MSG="${COMMIT_MSG:-chore: agent changes}"
PR_TITLE="${PR_TITLE:-Agent PR}"
PR_BODY="${PR_BODY:-Automated agent PR cycle.}"
TASK_CMD="${TASK_CMD:-}"

usage() {
  cat <<'EOF'
Usage:
  agent-pr-cycle.sh --task-cmd "<command>" [options]

Required:
  --task-cmd "..."       Command to run inside temp worktree.

Options:
  --repo <path>           Repo path (default: /Users/hd/Developer/cortana)
  --base <branch>         Base branch (default: main)
  --branch <name>         Exact branch name (default: agent/<timestamp>)
  --branch-prefix <pfx>   Branch prefix when --branch omitted (default: agent)
  --commit-msg "..."      Commit message
  --pr-title "..."        PR title
  --pr-body "..."         PR body
  --no-pr                 Skip gh pr create (push only)
  -h, --help              Help

Examples:
  agent-pr-cycle.sh \
    --task-cmd "pnpm lint && pnpm test" \
    --branch-prefix codex \
    --commit-msg "fix: harden repo sync" \
    --pr-title "Harden repo sync" \
    --pr-body "..."
EOF
}

NO_PR=0
BRANCH_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-cmd) TASK_CMD="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --base) BASE_BRANCH="$2"; shift 2 ;;
    --branch) BRANCH_NAME="$2"; shift 2 ;;
    --branch-prefix) BRANCH_PREFIX="$2"; shift 2 ;;
    --commit-msg) COMMIT_MSG="$2"; shift 2 ;;
    --pr-title) PR_TITLE="$2"; shift 2 ;;
    --pr-body) PR_BODY="$2"; shift 2 ;;
    --no-pr) NO_PR=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$TASK_CMD" ]] || { echo "ERROR: --task-cmd is required" >&2; exit 2; }
[[ -d "$REPO/.git" ]] || { echo "ERROR: not a git repo: $REPO" >&2; exit 2; }

if [[ -z "$BRANCH_NAME" ]]; then
  BRANCH_NAME="${BRANCH_PREFIX}/$(date +%Y%m%d-%H%M%S)"
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI required for PR creation" >&2
  exit 2
fi

PRIMARY_START_BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
WORKTREE="$(mktemp -d /tmp/agent-pr-cycle.XXXXXX)"
CLEANUP_DONE=0

cleanup() {
  if [[ "$CLEANUP_DONE" -eq 1 ]]; then
    return 0
  fi

  set +e
  if [[ -d "$WORKTREE" ]]; then
    git -C "$REPO" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
    rm -rf "$WORKTREE" >/dev/null 2>&1 || true
  fi

  git -C "$REPO" fetch origin --prune >/dev/null 2>&1 || true
  git -C "$REPO" checkout "$BASE_BRANCH" >/dev/null 2>&1 || true
  git -C "$REPO" pull --ff-only origin "$BASE_BRANCH" >/dev/null 2>&1 || true

  CLEANUP_DONE=1
}
trap cleanup EXIT

# Hard fail on tracked changes in primary worktree (protects human local edits).
if [[ -n "$(git -C "$REPO" status --porcelain | awk 'substr($0,1,1)!="?" || substr($0,2,1)!="?"')" ]]; then
  echo "ERROR: tracked changes present in $REPO; refusing to run" >&2
  exit 1
fi

# Keep main synced for next run.
git -C "$REPO" fetch origin --prune
git -C "$REPO" checkout "$BASE_BRANCH"
git -C "$REPO" pull --ff-only origin "$BASE_BRANCH"

# Isolated branch worktree.
git -C "$REPO" worktree add -b "$BRANCH_NAME" "$WORKTREE" "origin/$BASE_BRANCH"

echo "INFO worktree=$WORKTREE branch=$BRANCH_NAME"
(
  cd "$WORKTREE"
  bash -lc "$TASK_CMD"
)

if [[ -z "$(git -C "$WORKTREE" status --porcelain)" ]]; then
  echo "INFO no changes detected; skipping commit/pr"
  exit 0
fi

git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -m "$COMMIT_MSG"
git -C "$WORKTREE" push -u origin "$BRANCH_NAME"

if [[ "$NO_PR" -eq 0 ]]; then
  gh pr create \
    --repo "$(git -C "$WORKTREE" config --get remote.origin.url | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')" \
    --base "$BASE_BRANCH" \
    --head "$BRANCH_NAME" \
    --title "$PR_TITLE" \
    --body "$PR_BODY"
fi

echo "INFO cycle complete branch=$BRANCH_NAME"
