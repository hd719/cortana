#!/usr/bin/env bash
set -euo pipefail
assert_true(){ "$@" || { echo "ASSERT FAILED: $*"; exit 1; }; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
MOCK="$TMP/mock-psql"
cat > "$MOCK" <<'PSQL'
#!/usr/bin/env bash
echo "$*" >> "${RUN_SQL_LOG}"
exit 0
PSQL
chmod +x "$MOCK"
export RUN_SQL_LOG="$TMP/sql.log"

# shellcheck source=/dev/null
source /Users/hd/openclaw/tools/task-board/emit-run-event.sh
PSQL_BIN="$MOCK"
CORTANA_DB=test

emit_run_event "run-1" "123" "started" "unit-test" '{"k":"v"}'
assert_true grep -q "run-1" "$TMP/sql.log"
assert_true grep -q "123" "$TMP/sql.log"
assert_true grep -q "started" "$TMP/sql.log"

emit_run_event "run-2" "" "completed" "" ""
assert_true grep -q "run-2" "$TMP/sql.log"
assert_true grep -q "NULLIF('','')" "$TMP/sql.log"

echo "PASS: emit-run-event"
