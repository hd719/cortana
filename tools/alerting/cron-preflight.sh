#!/usr/bin/env bash
set -euo pipefail

# Cron preflight / quality gate
# Usage: cron-preflight.sh <cron_name> [required_check ...]
# exits non-zero if preflight fails; writes quarantine marker + logs reason.

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin"

DB="${CORTANA_DB:-cortana}"
CRON_NAME="${1:-}"
shift || true
REQUIRED=("$@")
[[ -n "$CRON_NAME" ]] || { echo "usage: $0 <cron_name> [required_check ...]"; exit 2; }

QDIR="${HOME}/.openclaw/cron/quarantine"
RUN_DIR="${HOME}/.openclaw/cron/runs"
mkdir -p "$QDIR"
QFILE="$QDIR/${CRON_NAME}.quarantined"

log_event() {
  local sev="$1" msg="$2" meta="${3:-{}}"
  local esc_msg
  esc_msg=$(echo "$msg" | sed "s/'/''/g")
  local esc_meta
  esc_meta=$(echo "$meta" | sed "s/'/''/g")
  psql "$DB" -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('cron_preflight', '${CRON_NAME}', '${sev}', '${esc_msg}', '${esc_meta}');" >/dev/null 2>&1 || true
}

quarantine() {
  local reason="$1"
  printf '%s\n' "$(date -Iseconds) $reason" > "$QFILE"
  log_event "warning" "Cron quarantined: $reason" "{\"cron\":\"$CRON_NAME\",\"reason\":\"$reason\"}"
  echo "preflight failed: $reason"
  exit 1
}

run_artifact_rotation() {
  local repo_root rotator
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  rotator="$repo_root/cron/rotate-cron-artifacts.sh"
  if [[ -x "$rotator" ]]; then
    if ! "$rotator" >/dev/null 2>&1; then
      log_event "warning" "Cron artifact rotation failed" "{\"cron\":\"$CRON_NAME\",\"script\":\"$rotator\"}"
    fi
  else
    log_event "warning" "Cron artifact rotator missing or not executable" "{\"cron\":\"$CRON_NAME\",\"script\":\"$rotator\"}"
  fi
}

run_meta_monitor() {
  local repo_root monitor_script
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  monitor_script="$repo_root/monitoring/meta-monitor.sh"
  if [[ -x "$monitor_script" ]]; then
    if ! "$monitor_script" >/dev/null 2>&1; then
      log_event "warning" "Meta-monitor run failed during preflight hygiene" "{\"cron\":\"$CRON_NAME\",\"script\":\"$monitor_script\"}"
    fi
  else
    log_event "warning" "Meta-monitor missing or not executable" "{\"cron\":\"$CRON_NAME\",\"script\":\"$monitor_script\"}"
  fi
}

warn_oversized_artifacts() {
  [[ -d "$RUN_DIR" ]] || return 0
  local warned=0
  while IFS= read -r -d '' f; do
    local sz
    sz=$(stat -f%z "$f" 2>/dev/null || echo 0)
    if [[ "$sz" -gt 1048576 ]]; then
      warned=1
      log_event "warning" "Cron run artifact exceeds 1MB" "{\"cron\":\"$CRON_NAME\",\"file\":\"$f\",\"bytes\":$sz,\"threshold\":1048576}"
    fi
  done < <(find "$RUN_DIR" -maxdepth 1 -type f -name "*.jsonl" -print0)

  if [[ $warned -eq 1 ]]; then
    echo "warning: oversized cron artifacts detected (>1MB)"
  fi
}

# Core checks
check_pg() { psql "$DB" -c 'SELECT 1;' >/dev/null 2>&1; }
check_gog() { timeout 8 gog --account hameldesai3@gmail.com auth list --no-input >/dev/null 2>&1; }
check_gog_oauth() {
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  timeout 20 "$repo_root/gog/oauth-refresh.sh" >/dev/null 2>&1
}
check_fitness() { curl -sSf --max-time 8 http://localhost:3033/health >/dev/null 2>&1; }
check_openclaw() { openclaw gateway status >/dev/null 2>&1; }

run_check() {
  local chk="$1"
  case "$chk" in
    pg) check_pg ;;
    gog) check_gog ;;
    gog_oauth) check_gog_oauth ;;
    fitness) check_fitness ;;
    gateway) check_openclaw ;;
    *) quarantine "unknown preflight check '$chk'" ;;
  esac
}

# Non-blocking hygiene checks
run_artifact_rotation
run_meta_monitor
warn_oversized_artifacts

if [[ -f "$QFILE" ]]; then
  # Auto-release quarantine if all requested checks pass now
  all_ok=1
  for c in "${REQUIRED[@]}"; do
    if ! run_check "$c"; then all_ok=0; break; fi
  done
  if [[ $all_ok -eq 1 ]]; then
    rm -f "$QFILE"
    log_event "info" "Cron quarantine released after successful preflight" "{\"cron\":\"$CRON_NAME\"}"
  else
    echo "cron still quarantined: $CRON_NAME"
    exit 1
  fi
fi

for c in "${REQUIRED[@]}"; do
  if ! run_check "$c"; then
    quarantine "required check failed: $c"
  fi
done

log_event "info" "Preflight passed" "{\"cron\":\"$CRON_NAME\",\"checks\":$(printf '%s\n' "${REQUIRED[@]}" | jq -R . | jq -s .)}"
echo "preflight ok: $CRON_NAME"
