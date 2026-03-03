#!/usr/bin/env bash
set -euo pipefail

IDEMP_DIR="${IDEMP_DIR:-$HOME/.openclaw/tmp/idempotency}"
mkdir -p "$IDEMP_DIR"

generate_operation_id() {
  local ts rand
  ts="$(date +%s%N 2>/dev/null || date +%s)"
  rand="$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || echo $$)"
  echo "op_${ts}_${rand}"
}

check_idempotency() {
  local op_id="${1:-}"
  [[ -z "$op_id" ]] && return 1
  [[ -f "$IDEMP_DIR/${op_id}.done" ]]
}

log_idempotency() {
  local op_id="${1:-}"
  local op_type="${2:-unknown}"
  local status="${3:-unknown}"
  local metadata="${4:-{}}"
  [[ -z "$op_id" ]] && return 0

  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"ts":"%s","op_id":"%s","op_type":"%s","status":"%s","metadata":%s}\n' \
    "$ts" "$op_id" "$op_type" "$status" "$metadata" >> "$IDEMP_DIR/events.jsonl" || true

  if [[ "$status" == "completed" ]]; then
    printf '%s\n' "$ts" > "$IDEMP_DIR/${op_id}.done" || true
  fi
}

# Transaction shims for scripts that expect these helpers.
begin_transaction() { :; }
transaction_exec() {
  local sql="${1:-}"
  [[ -z "$sql" ]] && return 0
  psql "${CORTANA_DB:-cortana}" -v ON_ERROR_STOP=1 -c "$sql" >/dev/null
}
commit_transaction() { :; }
rollback_transaction() { :; }
