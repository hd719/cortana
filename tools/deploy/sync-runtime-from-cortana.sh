#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEFAULT_DEPLOY_REPO="${CORTANA_DEPLOY_REPO:-/Users/hd/Developer/cortana-deploy}"
if [[ -z "${SOURCE_REPO:-}" ]]; then
  if [[ -d "$DEFAULT_DEPLOY_REPO/.git" ]]; then
    SOURCE_REPO="$DEFAULT_DEPLOY_REPO"
  else
    SOURCE_REPO="${CORTANA_SOURCE_REPO:-/Users/hd/Developer/cortana}"
  fi
fi
COMPAT_REPO="${COMPAT_REPO:-${RUNTIME_REPO:-/Users/hd/openclaw}}"
SOURCE_BRANCH="${SOURCE_BRANCH:-main}"
RUNTIME_HOME="${RUNTIME_HOME:-$HOME}"
SKIP_OPENCLAW_CHECK=false
SKIP_CRON_SYNC=false
SKIP_COMPAT_SHIM=false

usage() {
  cat <<'EOF'
Canonical runtime deploy: source repo stays authoritative; ~/openclaw becomes a compatibility shim.

Usage:
  sync-runtime-from-cortana.sh [--source-repo <path>] [--compat-repo <path>] [--runtime-home <path>] [--skip-openclaw-check] [--skip-cron-sync] [--skip-compat-shim]

Safety rules:
  - source repo must be clean, on main, and exactly at origin/main
  - if /Users/hd/Developer/cortana-deploy exists, it is preferred as the default source repo
  - no destructive reset is performed
  - existing ~/openclaw checkout is backed up before being replaced with a shim
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
    --compat-repo|--runtime-repo)
      COMPAT_REPO="$2"
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
    --skip-compat-shim)
      SKIP_COMPAT_SHIM=true
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

previous_compat_commit=""
if [[ -d "$COMPAT_REPO/.git" ]]; then
  previous_compat_commit="$(git_out "$COMPAT_REPO" rev-parse HEAD)"
fi

log "Verifying source repo"
fetch_branch "$SOURCE_REPO" "$SOURCE_BRANCH"
require_clean_repo "$SOURCE_REPO" "source"
require_branch "$SOURCE_REPO" "source" "$SOURCE_BRANCH"
require_upstream "$SOURCE_REPO" "source" "$SOURCE_BRANCH"
require_synced_with_origin "$SOURCE_REPO" "source" "$SOURCE_BRANCH"

target_commit="$(git_out "$SOURCE_REPO" rev-parse HEAD)"

if [[ "$SKIP_COMPAT_SHIM" == false ]]; then
  log "Ensuring compatibility shim at $COMPAT_REPO"
  bash "$ROOT_DIR/tools/openclaw/install-compat-shim.sh" \
    --source-repo "$SOURCE_REPO" \
    --compat-repo "$COMPAT_REPO"
fi

if [[ "$SKIP_CRON_SYNC" == false ]]; then
  log "Syncing repo cron config into runtime state"
  npx tsx "$ROOT_DIR/tools/cron/sync-cron-to-runtime.ts" \
    --repo-root "$SOURCE_REPO" \
    --runtime-home "$RUNTIME_HOME" >/dev/null
fi

log "Verifying deploy state"
if [[ "$SKIP_COMPAT_SHIM" == false ]]; then
  bash "$ROOT_DIR/tools/openclaw/install-compat-shim.sh" \
    --source-repo "$SOURCE_REPO" \
    --compat-repo "$COMPAT_REPO" \
    --check >/dev/null
fi

if [[ "$SKIP_CRON_SYNC" == false ]]; then
  cron_check="$(npx tsx "$ROOT_DIR/tools/cron/sync-cron-to-runtime.ts" --check --repo-root "$SOURCE_REPO" --runtime-home "$RUNTIME_HOME")"
  [[ "$cron_check" == "IN_SYNC" ]] || die "runtime cron state failed verification"
fi

if [[ "$SKIP_OPENCLAW_CHECK" == false ]]; then
  command -v openclaw >/dev/null 2>&1 || die "openclaw CLI not found for runtime verification"
  if ! openclaw gateway status --no-probe >/tmp/runtime-deploy-gateway-status.out 2>/tmp/runtime-deploy-gateway-status.err; then
    cat /tmp/runtime-deploy-gateway-status.out >&2 2>/dev/null || true
    cat /tmp/runtime-deploy-gateway-status.err >&2 2>/dev/null || true
    die "openclaw gateway service check failed after deploy"
  fi
fi

state_file="$RUNTIME_HOME/.openclaw/state/runtime-deploy.json"
mkdir -p "$(dirname "$state_file")"
cat >"$state_file" <<EOF
{
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "mode": "compat_shim",
  "sourceRepo": "$SOURCE_REPO",
  "compatRepo": "$COMPAT_REPO",
  "branch": "$SOURCE_BRANCH",
  "previousCompatCommit": "${previous_compat_commit}",
  "deployedCommit": "$target_commit"
}
EOF

log "Runtime deploy complete"
printf 'source=%s\ncompat=%s\nprevious=%s\ndeployed=%s\n' \
  "$SOURCE_REPO" "$COMPAT_REPO" "$previous_compat_commit" "$target_commit"
