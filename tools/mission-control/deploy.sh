#!/bin/bash
set -euo pipefail

LOG_DIR="/Users/hd/openclaw/tools/mission-control/logs"
LOG_FILE="$LOG_DIR/deploy.log"
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

fail() {
  log "❌ DEPLOY FAILED: $*"
  exit 1
}

log "🚀 Starting mission-control deploy"

cd /Users/hd/Developer/cortana-external || fail "Unable to cd to repo root"
log "Pulling latest changes from origin/main"
git pull origin main || fail "git pull failed"

cd apps/mission-control || fail "Unable to cd to apps/mission-control"

log "Installing dependencies (frozen lockfile)"
/opt/homebrew/bin/pnpm install --frozen-lockfile || fail "pnpm install failed"

log "Building app"
/opt/homebrew/bin/pnpm build || fail "pnpm build failed"

log "Restarting launchd service"
launchctl kickstart -k gui/$(id -u)/com.cortana.mission-control || fail "launchctl kickstart failed"

log "✅ DEPLOY SUCCESS"
