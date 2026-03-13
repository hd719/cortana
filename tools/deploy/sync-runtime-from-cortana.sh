#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

SOURCE_REPO="${SOURCE_REPO:-/Users/hd/Developer/cortana}"
RUNTIME_REPO="${RUNTIME_REPO:-/Users/hd/openclaw}"
SOURCE_BRANCH="${SOURCE_BRANCH:-main}"
RUNTIME_BRANCH="${RUNTIME_BRANCH:-main}"
RUNTIME_HOME="${RUNTIME_HOME:-$HOME}"
SKIP_OPENCLAW_CHECK=false
SKIP_CRON_SYNC=false

usage() {
  cat <<'EOF'
Controlled runtime deploy: sync /Users/hd/openclaw from /Users/hd/Developer/cortana.

Usage:
  sync-runtime-from-cortana.sh [--source-repo <path>] [--runtime-repo <path>] [--runtime-home <path>] [--skip-openclaw-check] [--skip-cron-sync]

Safety rules:
  - source repo must be clean, on main, and exactly at origin/main
  - runtime repo must be clean, on main, and fast-forwardable to the source commit
  - no destructive reset is performed
EOF
}

log() {
  printf '[runtime-deploy] %s\n' "$*"
}

die() {
  printf '[runtime-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

git_out() {
  git -C "$1" "${@:2}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-repo)
      SOURCE_REPO="$2"
      shift 2
      ;;
    --runtime-repo)
      RUNTIME_REPO="$2"
      shift 2
      ;;
    --runtime-home)
      RUNTIME_HOME="$2"
      shift 2
      ;;
    --skip-openclaw-check)
      SKIP_OPENCLAW_CHECK=true
      shift
      ;;
    --skip-cron-sync)
      SKIP_CRON_SYNC=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -d "$SOURCE_REPO/.git" ]] || die "source repo missing: $SOURCE_REPO"
[[ -d "$RUNTIME_REPO/.git" ]] || die "runtime repo missing: $RUNTIME_REPO"

require_clean_repo() {
  local repo="$1"
  local label="$2"
  local status
  status="$(git_out "$repo" status --porcelain --untracked-files=all)"
  [[ -z "$status" ]] || die "$label repo has local changes; refusing deploy"
}

require_branch() {
  local repo="$1"
  local label="$2"
  local expected="$3"
  local branch
  branch="$(git_out "$repo" rev-parse --abbrev-ref HEAD)"
  [[ "$branch" == "$expected" ]] || die "$label repo must be on $expected (found $branch)"
}

require_upstream() {
  local repo="$1"
  local label="$2"
  local expected="$3"
  local upstream
  upstream="$(git_out "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  [[ "$upstream" == "origin/$expected" ]] || die "$label repo must track origin/$expected (found ${upstream:-none})"
}

fetch_branch() {
  local repo="$1"
  local branch="$2"
  git_out "$repo" fetch origin "$branch" --prune --quiet
}

require_synced_with_origin() {
  local repo="$1"
  local label="$2"
  local branch="$3"
  local head remote_head
  head="$(git_out "$repo" rev-parse HEAD)"
  remote_head="$(git_out "$repo" rev-parse "origin/$branch")"
  [[ "$head" == "$remote_head" ]] || die "$label repo is not synced with origin/$branch"
}

source_remote="$(git_out "$SOURCE_REPO" remote get-url origin)"
runtime_remote="$(git_out "$RUNTIME_REPO" remote get-url origin)"
[[ "$source_remote" == "$runtime_remote" ]] || die "source/runtime origin remotes differ"

log "Verifying source repo"
fetch_branch "$SOURCE_REPO" "$SOURCE_BRANCH"
require_clean_repo "$SOURCE_REPO" "source"
require_branch "$SOURCE_REPO" "source" "$SOURCE_BRANCH"
require_upstream "$SOURCE_REPO" "source" "$SOURCE_BRANCH"
require_synced_with_origin "$SOURCE_REPO" "source" "$SOURCE_BRANCH"

target_commit="$(git_out "$SOURCE_REPO" rev-parse HEAD)"
previous_runtime_commit="$(git_out "$RUNTIME_REPO" rev-parse HEAD)"

log "Verifying runtime repo"
fetch_branch "$RUNTIME_REPO" "$RUNTIME_BRANCH"
require_clean_repo "$RUNTIME_REPO" "runtime"
require_branch "$RUNTIME_REPO" "runtime" "$RUNTIME_BRANCH"
require_upstream "$RUNTIME_REPO" "runtime" "$RUNTIME_BRANCH"

if [[ "$previous_runtime_commit" != "$target_commit" ]]; then
  if ! git_out "$RUNTIME_REPO" merge-base --is-ancestor "$previous_runtime_commit" "$target_commit" >/dev/null 2>&1; then
    die "runtime repo cannot fast-forward from $previous_runtime_commit to $target_commit"
  fi
fi

log "Deploying $target_commit to runtime repo"
if [[ "$previous_runtime_commit" == "$target_commit" ]]; then
  log "Runtime repo already at target commit"
else
  git_out "$RUNTIME_REPO" merge --ff-only "$target_commit" >/dev/null
fi

if [[ "$SKIP_CRON_SYNC" == false ]]; then
  log "Syncing repo cron config into runtime state"
  npx tsx "$ROOT_DIR/tools/cron/sync-cron-to-runtime.ts" \
    --repo-root "$RUNTIME_REPO" \
    --runtime-home "$RUNTIME_HOME" >/dev/null
fi

log "Verifying runtime deploy"
runtime_head="$(git_out "$RUNTIME_REPO" rev-parse HEAD)"
[[ "$runtime_head" == "$target_commit" ]] || die "runtime repo HEAD mismatch after deploy"
require_clean_repo "$RUNTIME_REPO" "runtime"

if [[ "$SKIP_CRON_SYNC" == false ]]; then
  cron_check="$(npx tsx "$ROOT_DIR/tools/cron/sync-cron-to-runtime.ts" --check --repo-root "$RUNTIME_REPO" --runtime-home "$RUNTIME_HOME")"
  [[ "$cron_check" == "IN_SYNC" ]] || die "runtime cron state failed verification"
fi

if [[ "$SKIP_OPENCLAW_CHECK" == false ]]; then
  command -v openclaw >/dev/null 2>&1 || die "openclaw CLI not found for runtime verification"
  if ! openclaw gateway status >/tmp/runtime-deploy-gateway-status.out 2>/tmp/runtime-deploy-gateway-status.err; then
    cat /tmp/runtime-deploy-gateway-status.out >&2 2>/dev/null || true
    cat /tmp/runtime-deploy-gateway-status.err >&2 2>/dev/null || true
    die "openclaw gateway status failed after deploy"
  fi
fi

state_file="$RUNTIME_HOME/.openclaw/state/runtime-deploy.json"
mkdir -p "$(dirname "$state_file")"
cat >"$state_file" <<EOF
{
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sourceRepo": "$SOURCE_REPO",
  "runtimeRepo": "$RUNTIME_REPO",
  "branch": "$SOURCE_BRANCH",
  "previousRuntimeCommit": "$previous_runtime_commit",
  "deployedCommit": "$target_commit"
}
EOF

log "Runtime deploy complete"
printf 'source=%s\nruntime=%s\nprevious=%s\ndeployed=%s\n' \
  "$SOURCE_REPO" "$RUNTIME_REPO" "$previous_runtime_commit" "$target_commit"
