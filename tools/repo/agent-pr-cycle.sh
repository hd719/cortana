#!/usr/bin/env bash
set -euo pipefail

# Agent PR lifecycle helper:
# 1) sync local main with origin/main
# 2) create ephemeral temp worktree + feature branch
# 3) run task command inside isolated worktree
# 4) if changes exist, commit + push + open PR
# 5) cleanup: remove temp worktree and return primary repo to clean main
#
# Completion contract (Step 7 hardening): every successful run must end in exactly one of
#   - pr_opened     (changes exist and a PR URL is known)
#   - no_pr_needed  (no changes, or caller explicitly opts out via --no-pr)
#   - blocked       (branch/commit exists but PR was not opened or another blocker occurred)

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
EOF
}

json_escape() {
  python3 - "$1" <<'PY'
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

print_result() {
  local result="$1"
  local reason="${2:-}"
  local detail="${3:-}"
  local pr_url="${4:-}"
  local commit="${5:-}"
  local branch="${6:-}"
  local dirty="${7:-false}"

  printf '{'
  printf '"result":%s,' "$(json_escape "$result")"
  printf '"reason":%s,' "$(json_escape "$reason")"
  printf '"detail":%s,' "$(json_escape "$detail")"
  if [[ -n "$pr_url" ]]; then
    printf '"pr_url":%s,' "$(json_escape "$pr_url")"
  else
    printf '"pr_url":null,'
  fi
  if [[ -n "$commit" ]]; then
    printf '"commit":%s,' "$(json_escape "$commit")"
  else
    printf '"commit":null,'
  fi
  if [[ -n "$branch" ]]; then
    printf '"branch":%s,' "$(json_escape "$branch")"
  else
    printf '"branch":null,'
  fi
  printf '"dirty":%s' "$dirty"
  printf '}\n'
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
if ! git -C "$REPO" diff --quiet --ignore-submodules -- || ! git -C "$REPO" diff --cached --quiet --ignore-submodules --; then
  print_result "blocked" "primary_repo_dirty" "tracked changes present in $REPO; refusing to run" "" "" "$BRANCH_NAME" true
  exit 1
fi

# Keep main synced for next run.
git -C "$REPO" fetch origin --prune
git -C "$REPO" checkout "$BASE_BRANCH"
git -C "$REPO" pull --ff-only origin "$BASE_BRANCH"

# Isolated branch worktree.
git -C "$REPO" worktree add -b "$BRANCH_NAME" "$WORKTREE" "origin/$BASE_BRANCH"

(
  cd "$WORKTREE"
  bash -lc "$TASK_CMD"
)

if [[ -z "$(git -C "$WORKTREE" status --porcelain)" ]]; then
  print_result "no_pr_needed" "no_changes_detected" "Task command finished cleanly with no repository changes" "" "" "$BRANCH_NAME" false
  exit 0
fi

git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -m "$COMMIT_MSG"
COMMIT_SHA="$(git -C "$WORKTREE" rev-parse HEAD)"
git -C "$WORKTREE" push -u origin "$BRANCH_NAME"

if [[ "$NO_PR" -eq 1 ]]; then
  print_result "no_pr_needed" "push_only_requested" "Changes were committed and pushed, but PR creation was explicitly disabled via --no-pr" "" "$COMMIT_SHA" "$BRANCH_NAME" false
  exit 0
fi

PR_URL=""
CREATE_ERR=""
set +e
CREATE_OUT="$(cd "$WORKTREE" && gh pr create --base "$BASE_BRANCH" --head "$BRANCH_NAME" --title "$PR_TITLE" --body "$PR_BODY" 2>&1)"
CREATE_RC=$?
set -e
if [[ $CREATE_RC -eq 0 ]]; then
  PR_URL="$(printf '%s\n' "$CREATE_OUT" | grep -Eo 'https://github.com/[^ ]+/pull/[0-9]+' | tail -n1 || true)"
else
  CREATE_ERR="$CREATE_OUT"
fi

if [[ -z "$PR_URL" ]]; then
  set +e
  PR_URL="$(cd "$WORKTREE" && gh pr list --head "$BRANCH_NAME" --json url --limit 1 2>/dev/null | python3 -c 'import json,sys
try:
    payload=json.load(sys.stdin)
except Exception:
    payload=[]
if isinstance(payload, list) and payload:
    print(payload[0].get("url", ""))')"
  LIST_RC=$?
  set -e
  if [[ $LIST_RC -ne 0 && -z "$PR_URL" ]]; then
    PR_URL=""
  fi
fi

if [[ -n "$PR_URL" ]]; then
  print_result "pr_opened" "pr_available" "Implementation changes committed, pushed, and linked to a PR" "$PR_URL" "$COMMIT_SHA" "$BRANCH_NAME" false
  exit 0
fi

DETAIL="No pull request was created after branch work was committed and pushed. branch=$BRANCH_NAME commit=$COMMIT_SHA"
if [[ -n "$CREATE_ERR" ]]; then
  DETAIL+=" gh_error=$(printf '%s' "$CREATE_ERR" | tr '\n' ' ' | sed 's/  */ /g')"
fi
print_result "blocked" "branch_exists_no_pr" "$DETAIL" "" "$COMMIT_SHA" "$BRANCH_NAME" false
exit 1
