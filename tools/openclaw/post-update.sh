#!/usr/bin/env bash
set -euo pipefail

RUNTIME_JOBS="$HOME/.openclaw/cron/jobs.json"
REPO_JOBS="/Users/hd/clawd/config/cron/jobs.json"
OPENCLAW_DIR="/opt/homebrew/lib/node_modules/openclaw"
BACKUP_DIR="${TMPDIR:-/tmp}/openclaw-post-update.$(date +%s)"

ROLLBACK_NEEDED=false

log() {
  printf '[post-update] %s\n' "$1"
}

ensure_parent() {
  mkdir -p "$(dirname "$1")"
}

validate_json_file() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  [[ -s "$file" ]] || return 1
  /usr/bin/python3 - <<PY
import json,sys
p=sys.argv[1]
with open(p,'r',encoding='utf-8') as f:
    json.load(f)
PY
 "$file" >/dev/null 2>&1
}

backup_current_state() {
  mkdir -p "$BACKUP_DIR"
  if [[ -e "$RUNTIME_JOBS" || -L "$RUNTIME_JOBS" ]]; then
    cp -a "$RUNTIME_JOBS" "$BACKUP_DIR/runtime_jobs.backup" 2>/dev/null || true
  fi
  if [[ -f "$REPO_JOBS" ]]; then
    cp -a "$REPO_JOBS" "$BACKUP_DIR/repo_jobs.backup" 2>/dev/null || true
  fi
}

rollback() {
  [[ "$ROLLBACK_NEEDED" == "true" ]] || return 0
  log "Failure detected, rolling back to previous state..."

  if [[ -e "$BACKUP_DIR/runtime_jobs.backup" || -L "$BACKUP_DIR/runtime_jobs.backup" ]]; then
    rm -f "$RUNTIME_JOBS" 2>/dev/null || true
    cp -a "$BACKUP_DIR/runtime_jobs.backup" "$RUNTIME_JOBS" 2>/dev/null || true
    log "Restored runtime jobs.json from backup."
  fi

  if [[ -e "$BACKUP_DIR/repo_jobs.backup" ]]; then
    cp -a "$BACKUP_DIR/repo_jobs.backup" "$REPO_JOBS" 2>/dev/null || true
    log "Restored repo jobs.json from backup."
  fi
}

safe_symlink() {
  local target="$1"
  local link="$2"

  if [[ ! -e "$target" ]]; then
    log "Refusing to create symlink: target missing ($target)"
    return 1
  fi

  rm -f "$link"
  ln -s "$target" "$link"

  local actual
  actual="$(readlink "$link" || true)"
  [[ "$actual" == "$target" ]]
}

restore_jobs_symlink() {
  ensure_parent "$RUNTIME_JOBS"
  ensure_parent "$REPO_JOBS"

  if [[ -L "$RUNTIME_JOBS" ]]; then
    local target
    target="$(readlink "$RUNTIME_JOBS" || true)"
    if [[ "$target" == "$REPO_JOBS" && -f "$REPO_JOBS" ]]; then
      log "jobs.json symlink already correct."
      return 0
    fi
    log "jobs.json symlink points elsewhere; repairing."
  fi

  if [[ -f "$RUNTIME_JOBS" && ! -L "$RUNTIME_JOBS" ]]; then
    if [[ -f "$REPO_JOBS" ]]; then
      if cmp -s "$RUNTIME_JOBS" "$REPO_JOBS"; then
        log "Runtime and repo jobs.json are identical."
      else
        local drift_backup
        drift_backup="${REPO_JOBS}.runtime-drift.bak.$(date +%s)"
        cp -p "$RUNTIME_JOBS" "$drift_backup"
        cp "$RUNTIME_JOBS" "$REPO_JOBS"
        log "Detected jobs.json drift; saved runtime snapshot to $drift_backup and synced runtime -> repo."
      fi
    else
      cp "$RUNTIME_JOBS" "$REPO_JOBS"
      log "Repo jobs.json missing; seeded from runtime copy."
    fi
  fi

  if [[ ! -f "$REPO_JOBS" ]]; then
    echo '{"version":1,"jobs":[]}' > "$REPO_JOBS"
    log "Created default repo jobs.json (was missing)."
  fi

  if ! validate_json_file "$REPO_JOBS"; then
    log "Repo jobs.json invalid/empty; aborting."
    return 1
  fi

  if ! safe_symlink "$REPO_JOBS" "$RUNTIME_JOBS"; then
    log "Failed to create runtime symlink."
    return 1
  fi

  local linked_target
  linked_target="$(readlink "$RUNTIME_JOBS" || true)"
  if [[ "$linked_target" != "$REPO_JOBS" ]]; then
    log "Symlink verification failed: expected $REPO_JOBS, got ${linked_target:-<none>}"
    return 1
  fi

  if ! cmp -s "$REPO_JOBS" "$RUNTIME_JOBS"; then
    log "Symlink verification failed: runtime content does not match repo content."
    return 1
  fi

  if ! validate_json_file "$RUNTIME_JOBS"; then
    log "Runtime jobs.json symlink target failed validation."
    return 1
  fi

  log "Runtime jobs.json symlinked to repo, verified, and validated."
}

idempotency_test() {
  local before after
  before="$(readlink "$RUNTIME_JOBS" 2>/dev/null || true)"
  restore_jobs_symlink
  after="$(readlink "$RUNTIME_JOBS" 2>/dev/null || true)"

  if [[ "$before" != "$after" && -n "$before" ]]; then
    log "Idempotency warning: symlink target changed unexpectedly (${before} -> ${after})."
    return 1
  fi

  if ! validate_json_file "$REPO_JOBS" || ! validate_json_file "$RUNTIME_JOBS"; then
    log "Idempotency check failed JSON validation."
    return 1
  fi

  log "Idempotency test passed."
}

main() {
  trap rollback ERR
  ROLLBACK_NEEDED=true

  log "Starting OpenClaw post-update recovery..."
  backup_current_state

  restore_jobs_symlink

  log "Running: openclaw gateway install --force"
  openclaw gateway install --force

  log "Restoring LanceDB dependency in OpenClaw install..."
  (
    cd "$OPENCLAW_DIR"
    pnpm add @lancedb/lancedb
  )

  log "Running: openclaw gateway restart"
  openclaw gateway restart

  idempotency_test

  ROLLBACK_NEEDED=false
  log "Post-update recovery complete."
}

main "$@"
