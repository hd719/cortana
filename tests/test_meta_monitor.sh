#!/usr/bin/env bash
set -euo pipefail
assert_true(){ "$@" || { echo "ASSERT FAILED: $*"; exit 1; }; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/monitoring"
cp /Users/hd/openclaw/tools/monitoring/meta-monitor.sh "$TMP/monitoring/meta-monitor.sh"
chmod +x "$TMP/monitoring/meta-monitor.sh"
cat > "$TMP/monitoring/quarantine-tracker.sh" <<'QT'
#!/usr/bin/env bash
exit 0
QT
chmod +x "$TMP/monitoring/quarantine-tracker.sh"

MOCK="$TMP/mock-psql"
cat > "$MOCK" <<'PSQL'
#!/usr/bin/env bash
q="$*"
if [[ "$q" == *"EXTRACT(EPOCH FROM MAX(timestamp))"* ]]; then echo 0; exit 0; fi
if [[ "$q" == *"to_char(MAX(timestamp)"* ]]; then echo unknown; exit 0; fi
if [[ "$q" == *"INSERT INTO cortana_events"* ]]; then echo "$q" >> "${MOCK_LOG}"; exit 0; fi
exit 0
PSQL
chmod +x "$MOCK"
export MOCK_LOG="$TMP/sql.log"

PSQL_BIN="$MOCK" DB_NAME=test bash "$TMP/monitoring/meta-monitor.sh" >/dev/null
PSQL_BIN="$MOCK" DB_NAME=test bash "$TMP/monitoring/meta-monitor.sh" >/dev/null

assert_true grep -q "critical" "$TMP/sql.log"
STATE_FILE="$TMP/monitoring/state/meta-monitor-consecutive.state"
assert_true test -f "$STATE_FILE"
assert_true grep -q "watchdog=2" "$STATE_FILE"

echo "PASS: meta-monitor"
