#!/usr/bin/env bash
set -euo pipefail
assert_true(){ "$@" || { echo "ASSERT FAILED: $*"; exit 1; }; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
SCRIPT_COPY="$TMP/emit-alert-intent.sh"
cp /Users/hd/clawd/tools/alerting/emit-alert-intent.sh "$SCRIPT_COPY"

MOCK="$TMP/mock-psql"
cat > "$MOCK" <<'PSQL'
#!/usr/bin/env bash
echo "$*" >> "${ALERT_SQL_LOG}"
exit 0
PSQL
chmod +x "$MOCK"
export ALERT_SQL_LOG="$TMP/sql.log"

python3 - <<'PY' "$SCRIPT_COPY" "$MOCK"
from pathlib import Path
import sys
p=Path(sys.argv[1])
text=p.read_text()
text=text.replace('PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"', f'PSQL_BIN="{sys.argv[2]}"')
p.write_text(text)
PY
chmod +x "$SCRIPT_COPY"

out="$(bash "$SCRIPT_COPY" test_alert telegram)"
intent_id="$(python3 - <<'PY' "$out"
import json,sys
print(json.loads(sys.argv[1])["intent_id"])
PY
)"
exp="$(python3 - <<'PY' "$out"
import json,sys
print(json.loads(sys.argv[1])["expected_delivery_time"])
PY
)"
[[ "$intent_id" =~ ^[0-9a-f-]{36}$ ]] || { echo "bad uuid"; exit 1; }
[[ "$exp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || { echo "bad expected delivery time"; exit 1; }
assert_true grep -q "alert_intent" "$TMP/sql.log"

echo "PASS: alert-intent"
