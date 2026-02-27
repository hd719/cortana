#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

IDEMPOTENCY_PSQL_BIN="${IDEMPOTENCY_PSQL_BIN:-/opt/homebrew/opt/postgresql@17/bin/psql}"
IDEMPOTENCY_DB="${CORTANA_DB:-cortana}"
IDEMPOTENCY_SOURCE="${SOURCE:-idempotency}"
IDEMPOTENCY_TXN_FILE="${IDEMPOTENCY_TXN_FILE:-}"

_idem_sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

generate_operation_id() {
  if [[ -n "${CORTANA_OPERATION_ID:-}" ]]; then
    printf "%s\n" "$CORTANA_OPERATION_ID"
    return 0
  fi

  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
    return 0
  fi

  python3 - <<'PY'
import uuid
print(str(uuid.uuid4()))
PY
}

check_idempotency() {
  local operation_id="$1"
  local op_esc
  op_esc="$(_idem_sql_escape "$operation_id")"

  local count
  count="$($IDEMPOTENCY_PSQL_BIN "$IDEMPOTENCY_DB" -q -X -t -A -v ON_ERROR_STOP=1 -c "
    SELECT COUNT(*)::int
    FROM cortana_events
    WHERE event_type='idempotent_operation'
      AND COALESCE(metadata->>'operation_id','')='${op_esc}'
      AND COALESCE(metadata->>'status','') IN ('completed','success','done');
  " 2>/dev/null || echo 0)"
  count="${count//[[:space:]]/}"
  [[ "${count:-0}" -gt 0 ]]
}

log_idempotency() {
  local operation_id="$1"
  local operation_type="$2"
  local status="$3"
  local metadata="${4:-{}}"

  local op_esc type_esc status_esc meta_esc
  op_esc="$(_idem_sql_escape "$operation_id")"
  type_esc="$(_idem_sql_escape "$operation_type")"
  status_esc="$(_idem_sql_escape "$status")"
  meta_esc="$(_idem_sql_escape "$metadata")"

  $IDEMPOTENCY_PSQL_BIN "$IDEMPOTENCY_DB" -q -X -v ON_ERROR_STOP=1 -c "
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES (
      'idempotent_operation',
      '${IDEMPOTENCY_SOURCE}',
      CASE
        WHEN '${status_esc}' IN ('failed','error') THEN 'error'
        WHEN '${status_esc}' IN ('skipped','duplicate') THEN 'warning'
        ELSE 'info'
      END,
      'Idempotent operation ${type_esc} -> ${status_esc}',
      COALESCE('${meta_esc}'::jsonb, '{}'::jsonb)
        || jsonb_build_object(
          'operation_id','${op_esc}',
          'operation_type','${type_esc}',
          'status','${status_esc}',
          'logged_at', NOW()::text
        )
    );
  " >/dev/null 2>&1 || true
}

begin_transaction() {
  IDEMPOTENCY_TXN_FILE="$(mktemp -t cortana-txn.XXXXXX.sql)"
  printf "BEGIN;\n" > "$IDEMPOTENCY_TXN_FILE"
}

transaction_exec() {
  local sql="$1"
  if [[ -z "${IDEMPOTENCY_TXN_FILE:-}" || ! -f "$IDEMPOTENCY_TXN_FILE" ]]; then
    $IDEMPOTENCY_PSQL_BIN "$IDEMPOTENCY_DB" -q -X -v ON_ERROR_STOP=1 -c "$sql"
    return 0
  fi
  printf "%s\n" "$sql" >> "$IDEMPOTENCY_TXN_FILE"
}

commit_transaction() {
  if [[ -z "${IDEMPOTENCY_TXN_FILE:-}" || ! -f "$IDEMPOTENCY_TXN_FILE" ]]; then
    return 0
  fi
  printf "COMMIT;\n" >> "$IDEMPOTENCY_TXN_FILE"
  $IDEMPOTENCY_PSQL_BIN "$IDEMPOTENCY_DB" -q -X -v ON_ERROR_STOP=1 -f "$IDEMPOTENCY_TXN_FILE" >/dev/null
  rm -f "$IDEMPOTENCY_TXN_FILE"
  IDEMPOTENCY_TXN_FILE=""
}

rollback_transaction() {
  if [[ -n "${IDEMPOTENCY_TXN_FILE:-}" && -f "$IDEMPOTENCY_TXN_FILE" ]]; then
    rm -f "$IDEMPOTENCY_TXN_FILE"
    IDEMPOTENCY_TXN_FILE=""
  fi
}
