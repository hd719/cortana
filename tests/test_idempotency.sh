#!/usr/bin/env bash
set -euo pipefail
assert_true(){ "$@" || { echo "ASSERT FAILED: $*"; exit 1; }; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
MOCK="$TMP/mock-psql"
cat > "$MOCK" <<'PSQL'
#!/usr/bin/env bash
q="$*"
if [[ "$q" == *"SELECT COUNT(*)::int"* ]]; then
  echo "${IDEMPOTENCY_COUNT:-0}"
  exit 0
fi
if [[ "$q" == *"INSERT INTO cortana_events"* ]]; then
  echo "$q" >> "${IDEMPOTENCY_LOG}"
  exit 0
fi
exit 0
PSQL
chmod +x "$MOCK"
export IDEMPOTENCY_LOG="$TMP/sql.log"

# shellcheck source=/dev/null
source /Users/hd/clawd/tools/lib/idempotency.sh
IDEMPOTENCY_PSQL_BIN="$MOCK"
IDEMPOTENCY_DB=test

opid="$(generate_operation_id)"
[[ "$opid" =~ ^[0-9a-f-]{36}$ ]] || { echo "invalid uuid: $opid"; exit 1; }

export IDEMPOTENCY_COUNT=0
if check_idempotency "abc"; then echo "expected false"; exit 1; fi
export IDEMPOTENCY_COUNT=1
if ! check_idempotency "abc"; then echo "expected true"; exit 1; fi

log_idempotency "id-1" "job" "completed" '{"x":1}'
assert_true grep -q "idempotent_operation" "$IDEMPOTENCY_LOG"

echo "PASS: idempotency"
